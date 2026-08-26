// Standing instructions, honoured without an editor (GH #174).
//
// `code_intel_auto` used to be read in ONE place: the chip, which only exists
// when an editor is open on a file of that language. So "always for this
// project" quietly meant "always, once you open the right kind of file", and a
// task you opened to run a command had no server until you went looking for
// one. The point of saying always is not having to think about it.
//
// So the grant is decided from the TASK LIST instead, and the server is held
// open for as long as a covered task exists. The other half matters as much:
// when the last task on a checkout goes, the hold is released and the process
// stops. A standing instruction that only ever added servers would be a memory
// leak with a settings page.
//
// The planner below is pure so it can be tested; the driver under it is the
// only part that touches processes.

import { useApp } from "@/store/app";
import {
  useCodeIntel, checkoutRoot, grantKey, autoArms, autoStartsLanguage, type CodeIntelAuto,
} from "@/store/codeIntel";
import type { Project, Task } from "@/lib/types";

export interface AutoTarget {
  root: string;
  server: string;
  /** The tasks keeping it alive, so the grant's refcount matches reality. */
  taskIds: string[];
}

/**
 * Which (checkout, server) pairs a standing instruction covers right now.
 *
 * @param languagesFor what a project is written in. A parameter rather than
 *   detected here, because detection reads the file list over IPC and this has
 *   to stay pure enough to test.
 */
/**
 * How many servers a standing instruction may start on its own.
 *
 * Nothing bounded this. A polyglot repo set to "all" with ten worktree tasks
 * and four detected languages plans FORTY servers, and the measured figures in
 * serverNames.ts put that near 100 GB: rust-analyzer alone is ~3 GB and gopls
 * has been seen at 7. A cap does not make that a good idea, it stops the app
 * being the thing that did it silently. The user can still arm anything by
 * hand, one chip at a time, where the cost is disclosed.
 */
export const AUTO_START_CAP = 6;

export function planAutoStart(
  tasks: readonly Task[],
  projects: readonly Project[],
  languagesFor: (project: Project, task: Task) => readonly string[],
): AutoTarget[] {
  const byKey = new Map<string, AutoTarget>();
  for (const task of tasks) {
    if (task.archived) continue;
    const project = projects.find(p => p.id === task.project_id);
    if (!project) continue;
    const auto = (project.code_intel_auto ?? "off") as CodeIntelAuto;
    // "main" covers the checkout that never goes away; "all" also covers
    // worktrees, where the bill multiplies by the number of agents.
    if (!autoArms(auto, !!task.is_main_checkout)) continue;
    const root = checkoutRoot(task, project);
    if (!root) continue;
    for (const server of languagesFor(project, task)) {
      if (!autoStartsLanguage(project, server)) continue;
      const key = grantKey(root, server);
      const existing = byKey.get(key);
      if (existing) existing.taskIds.push(task.id);
      else byKey.set(key, { root, server, taskIds: [task.id] });
    }
  }
  // Deterministic before the cap, so which servers you get does not depend on
  // task ordering: main checkouts first (one server shared by every task on
  // them, the cheapest per unit of use), then by root and language.
  const all = [...byKey.values()].sort((a, b) =>
    b.taskIds.length - a.taskIds.length
    || a.root.localeCompare(b.root)
    || a.server.localeCompare(b.server));
  return all.slice(0, AUTO_START_CAP);
}

interface Hold {
  root: string;
  server: string;
  /** Whose existence justifies it, so the grant can be given back exactly. */
  taskIds: string[];
  release: () => void;
}

/** Holds, one per armed pair, so the server stays up while the tasks do. */
const holds = new Map<string, Hold>();

/**
 * Apply the plan: arm and START what is covered, release and STOP what is not.
 *
 * Starting eagerly is the whole point. A grant on its own only records
 * permission; the process does not exist until somebody acquires a client, and
 * "somebody" was previously an editor being opened. Holding one here is what
 * makes the first go-to-definition instant rather than a cold index.
 */
export async function applyAutoStart(targets: readonly AutoTarget[]): Promise<void> {
  const wanted = new Map(targets.map(t => [grantKey(t.root, t.server), t] as const));
  // Imported ONCE, up front. Reading `holds` and then awaiting an import
  // reopened the guard: `loadAll` runs on every window focus and fires this
  // without waiting, and a dynamic import yields even when cached, so two runs
  // both passed `holds.has(key)` and both acquired. The second `holds.set`
  // dropped the first release closure on the floor and that reference could
  // never be given back.
  const { acquireClient, stopClient } = await import("./host");

  // Release first: a checkout that lost its last task gives the memory back
  // before another one asks for some.
  for (const [key, hold] of [...holds]) {
    if (wanted.has(key)) continue;
    holds.delete(key);
    hold.release();
    // The GRANT goes too. Arming without ever releasing meant turning the
    // standing instruction off stopped the process and left every chip on that
    // checkout reading armed, so the next file opened respawned the server the
    // user had just switched off. `codeIntel.ts` promises the opposite: an
    // enablement never outlives its reason.
    for (const taskId of hold.taskIds) useCodeIntel.getState().release(key, taskId);
    // Only when nothing ELSE holds the grant. An editor armed from the chip on
    // the same checkout is a reason to keep the server, and stopClient does not
    // check for us.
    if ((useCodeIntel.getState().grants[key] ?? []).length === 0) {
      await stopClient(hold.root, hold.server);
    }
  }

  for (const [key, target] of wanted) {
    const existing = holds.get(key);
    // The set of tasks can change without the pair going away (a second task
    // opens on the same checkout). Arm the new ones, release the departed.
    const taskIds = new Set(target.taskIds);
    for (const taskId of target.taskIds) useCodeIntel.getState().arm(key, taskId);
    if (existing) {
      for (const gone of existing.taskIds.filter(id => !taskIds.has(id))) {
        useCodeIntel.getState().release(key, gone);
      }
      existing.taskIds = [...taskIds];
      continue;
    }
    holds.set(key, {
      root: target.root,
      server: target.server,
      taskIds: [...taskIds],
      release: acquireClient(target.root, target.server).release,
    });
  }
}

/** In flight, so two callers cannot interleave the plan they are applying.
 *  `loadAll` fires this on every window focus and never awaits it. */
let running: Promise<void> | null = null;

/** Detected languages per checkout, so the file list is read once. */
const detected = new Map<string, readonly string[]>();

/** Forget a checkout whose contents may have changed.
 *
 *  Called when a project's language settings change, which is the one moment
 *  the cached guess is known to be stale. It is deliberately NOT called on
 *  every file write: the guess is about what a repo IS, and a repo does not
 *  change language between saves. */
export function forgetDetectedLanguages(root?: string): void {
  if (root) detected.delete(root);
  else detected.clear();
}

/**
 * Read the task list, work out what is covered, and make it so.
 *
 * Cheap when nothing is auto-enabled, which is the default: no project with a
 * standing instruction means no file listing and no IPC at all.
 */
export function syncAutoStart(): Promise<void> {
  // Queued, never concurrent. Two runs interleaving could release a key and
  // then have the other re-acquire it between the delete and the stop, leaving
  // a live process no hold refers to.
  const next = (running ?? Promise.resolve()).then(syncAutoStartOnce, syncAutoStartOnce);
  running = next.catch(() => {});
  return next;
}

async function syncAutoStartOnce(): Promise<void> {
  // Dynamic, like the client itself: prefs.ts applies the theme to
  // document.documentElement at import time, and this module's PLANNER is
  // pure and unit-tested in a node environment. A static import would drag a
  // DOM requirement into that test's import graph (it already did once).
  const { usePrefs } = await import("@/store/prefs");
  if (!usePrefs.getState().codeIntelligence) {
    await applyAutoStart([]);
    return;
  }
  const { tasks, projects } = useApp.getState();
  const anyAuto = projects.some(p => (p.code_intel_auto ?? "off") !== "off");
  if (!anyAuto && !holds.size) return;

  // A declared language list wins: it is a decision, and guessing over it
  // would start servers somebody turned off on purpose.
  for (const task of tasks) {
    if (task.archived) continue;
    const project = projects.find(p => p.id === task.project_id);
    if (!project || project.code_intel_languages?.length) continue;
    if (!autoArms((project.code_intel_auto ?? "off") as CodeIntelAuto, !!task.is_main_checkout)) continue;
    const root = checkoutRoot(task, project);
    if (!root || detected.has(root)) continue;
    try {
      const { taskListFilesForFinder } = await import("@/lib/ipc");
      const { projectLanguages } = await import("./projectLanguages");
      detected.set(root, projectLanguages(await taskListFilesForFinder(task.id)));
    } catch {
      detected.set(root, []);   // an unreadable checkout starts nothing
    }
  }

  const plan = planAutoStart(tasks, projects, (project, task) =>
    project.code_intel_languages?.length
      ? project.code_intel_languages
      : detected.get(checkoutRoot(task, project)) ?? []);
  await applyAutoStart(plan);
}
