// Who may run a language server, and for how long (GH #174).
//
// A grant is on a CHECKOUT **and one server** (the main repo is one checkout,
// each worktree is another), made from a task, and it is deliberately NOT
// sticky. It is refcounted against the tasks on that checkout, and when the
// last of them is archived or closed the grant is dropped along with the
// server.
//
// Per SERVER, not per checkout, because the disclosure quotes a number and the
// number is per language. A Django checkout holds Python and JavaScript; if
// arming from `models.py` also armed TypeScript, the user would have agreed to
// ty's ~250 MB and then silently got a second process too. One repo, several
// languages, one decision each — and a decision is one click.
//
// That rule is the point of the design, not a tidiness measure. Worktrees
// usually disappear with their task, so a stale grant there is self-limiting —
// but the main checkout is permanent. A grant made once for a five-minute code
// read would otherwise sit on it forever and quietly resurrect a
// multi-gigabyte server months later, on a machine whose owner has long since
// forgotten they said yes. An enablement can never outlive its reason.
//
// It lives in memory, never on disk, for the same reason: persisting it would
// be exactly the stickiness this refuses.

import { create } from "zustand";
import type { Project, Task } from "@/lib/types";

/** The project's standing instruction for new checkouts. */
export type CodeIntelAuto = "off" | "main" | "all";

interface CodeNavState {
  /** `grantKey(root, server)` → the task ids that armed it. A list, because
   *  several tasks can share one checkout and the grant outlives any single
   *  one of them. */
  grants: Record<string, string[]>;
  /** Arm one server for a checkout, from a task. Idempotent per task. */
  arm: (key: string, taskId: string) => void;
  /** Drop one task's hold. The grant survives while a sibling still holds it. */
  release: (key: string, taskId: string) => void;
  /** Drop every hold a task had, wherever it had them (archive, close). */
  releaseTask: (taskId: string) => void;
  /** Reconcile against the tasks that still exist. A task removed behind our
   *  back (archived elsewhere, deleted on disk) must not keep a server alive. */
  pruneTo: (liveTaskIds: string[]) => void;
  isArmed: (key: string) => boolean;
}

/** The thing a grant is ABOUT: this checkout, this server. Two languages in
 *  one repo are two grants; two tasks on one checkout share both. */
export const grantKey = (root: string, server: string) => `${root}\u0000${server}`;

export const useCodeIntel = create<CodeNavState>((set, get) => ({
  grants: {},
  arm: (root, taskId) => {
    const cur = get().grants[root] ?? [];
    if (cur.includes(taskId)) return;  // no-op writes re-run every selector
    set(s => ({ grants: { ...s.grants, [root]: [...cur, taskId] } }));
  },
  release: (root, taskId) => {
    const cur = get().grants[root];
    if (!cur || !cur.includes(taskId)) return;
    const next = cur.filter(id => id !== taskId);
    set(s => {
      const grants = { ...s.grants };
      if (next.length) grants[root] = next;
      else delete grants[root];
      return { grants };
    });
  },
  releaseTask: (taskId) => {
    const grants = get().grants;
    if (!Object.values(grants).some(ids => ids.includes(taskId))) return;
    const next: Record<string, string[]> = {};
    for (const [root, ids] of Object.entries(grants)) {
      const kept = ids.filter(id => id !== taskId);
      if (kept.length) next[root] = kept;
    }
    set({ grants: next });
  },
  pruneTo: (liveTaskIds) => {
    const live = new Set(liveTaskIds);
    const grants = get().grants;
    let changed = false;
    const next: Record<string, string[]> = {};
    for (const [root, ids] of Object.entries(grants)) {
      const kept = ids.filter(id => live.has(id));
      if (kept.length !== ids.length) changed = true;
      if (kept.length) next[root] = kept;
    }
    if (!changed) return;
    set({ grants: next });
  },
  isArmed: (root) => (get().grants[root]?.length ?? 0) > 0,
}));

/** The checkout a task reads: its worktree, or the project root when the task
 *  runs in the main checkout. Two tasks that answer the same string share one
 *  server; two that do not, must not. */
export function checkoutRoot(task: Task, project: Project | undefined): string {
  if (task.is_main_checkout && project) return project.root_path;
  return task.path;
}

/**
 * The project that owns a checkout path.
 *
 * A checkout is a task's worktree or a project's main repo, so the way back is
 * through the tasks. Shared because two callers need the same answer and were
 * spelling it out separately: `host.ts` (to read the project's raw settings)
 * and `install.ts` (to read its server choice), and two copies of a lookup
 * like this drift into disagreeing about which project a path belongs to.
 */
export function projectForCheckout(
  tasks: Task[],
  projects: Project[],
  root: string,
): Project | undefined {
  for (const task of tasks) {
    const project = projects.find(p => p.id === task.project_id);
    if (project && checkoutRoot(task, project) === root) return project;
  }
  return undefined;
}

/** Which languages this project starts AUTOMATICALLY, when it has a standing
 *  instruction to start anything at all. Undefined means every language the
 *  detection found, which is the default.
 *
 *  Auto start only. It used to gate the editor chip, Search Everywhere and the
 *  nav hint as well, which made one list answer two different questions: "do
 *  not spend memory on Go here without asking" and "never offer me Go here".
 *  Only the first is worth a setting, and conflating them meant unticking a
 *  language to keep four servers from starting by themselves also took away
 *  the one-click button for it, with the cost disclosure that button carries.
 *  Everything termic can serve is offered on request; this decides what runs
 *  without one. */
export function autoStartsLanguage(
  project: { code_intel_languages?: string[] } | undefined,
  server: string | null,
): boolean {
  if (!server) return false;
  const list = project?.code_intel_languages;
  return !list || list.includes(server);
}

/** Does the project's standing instruction cover this checkout?
 *
 *  "main" covers the checkout that never goes away and costs one server per
 *  language however many tasks share it. "all" also covers worktrees, where
 *  the cost multiplies by the number of agents running. */
export function autoArms(auto: CodeIntelAuto | undefined, isMainCheckout: boolean): boolean {
  if (auto === "all") return true;
  if (auto === "main") return isMainCheckout;
  return false;
}
