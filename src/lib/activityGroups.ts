// Turn a flat `procmon` snapshot into the tree the Activity window renders:
//
//   project ─ task ─ row (agent / shell / run script)
//   Termic itself ─ app + WebKit sidecar rows
//
// Pure functions over plain data, so the grouping and the totals are unit
// tested without a live process table (src/lib/activityGroups.test.ts).
// The window's React tree only ever renders what comes out of here.

import type { ProcRow } from "@/lib/ipc";
import type { Project, Task } from "@/lib/types";

/** Rows that are Termic's own processes rather than something we spawned
 *  in a task. `webkit-*` covers the WebContent / GPU / Networking XPC
 *  services, which are ours but are not our children. */
export function isSelfRow(row: ProcRow): boolean {
  return row.kind === "app" || row.kind.startsWith("webkit-");
}

export interface ActivityRow extends ProcRow {
  /** What the row is called in the UI: the tab's persisted title when we
   *  have one, else a name derived from the kind and the process. */
  title: string;
}

export interface TaskGroup {
  taskId: string;
  /** Task name, or the raw id when the task is gone (archived mid-session). */
  taskName: string;
  branch: string | null;
  rows: ActivityRow[];
  cpuPct: number | null;
  memBytes: number;
}

export interface ProjectGroup {
  projectId: string;
  projectName: string;
  tasks: TaskGroup[];
  cpuPct: number | null;
  memBytes: number;
}

export interface Grouped {
  projects: ProjectGroup[];
  /** Termic's own processes: the app plus its WebKit sidecars. */
  self: ActivityRow[];
  selfCpuPct: number | null;
  selfMemBytes: number;
  /** Rows we could not attribute to a task (a PTY spawned without an
   *  owner, e.g. the Settings font preview). Shown in their own group
   *  rather than dropped, because an unattributed CPU hog still matters. */
  orphans: ActivityRow[];
  totalCpuPct: number | null;
  totalMemBytes: number;
}

const KIND_LABELS: Record<string, string> = {
  agent: "Agent",
  aux: "Terminal",
  shell: "Shell",
  run: "Run script",
  setup: "Setup script",
  custom: "Command",
  app: "Termic",
};

/** Row title. Prefers the tab's persisted title (what the user sees on the
 *  tab strip) and falls back to the kind plus the process name, which is
 *  all we have for shells and for tabs created this session. */
export function rowTitle(row: ProcRow, tabTitles: Map<string, string>): string {
  if (row.kind.startsWith("webkit-")) {
    // "webkit-webcontent" -> "WebContent" (the label Rust derived from the
    // XPC service's path, since every one of them reports the same comm).
    const raw = row.kind.slice("webkit-".length);
    return raw === "webcontent" ? "WebContent"
      : raw === "gpu" ? "GPU"
      : raw === "networking" ? "Networking"
      : raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  const persisted = row.tabId ? tabTitles.get(row.tabId)?.trim() : undefined;
  if (persisted) return persisted;
  if (row.tabId === "right-footer") return "Panel terminal";
  const kind = KIND_LABELS[row.kind] ?? row.kind;
  // The process name adds information only when it differs from the kind
  // ("Agent · claude" is useful, "Shell · zsh" less so but still honest).
  return row.label && row.label !== "?" ? `${kind} · ${row.label}` : kind;
}

/** Sum CPU across rows. Returns null only when NO row has a reading yet
 *  (first sample of a session), so a group never shows 0% while one of its
 *  rows is reporting real load. */
function sumCpu(rows: { cpuPct: number | null }[]): number | null {
  const known = rows.filter(r => r.cpuPct !== null);
  if (known.length === 0) return null;
  return known.reduce((a, r) => a + (r.cpuPct ?? 0), 0);
}

function sumMem(rows: { memBytes: number }[]): number {
  return rows.reduce((a, r) => a + r.memBytes, 0);
}

/** Heaviest first, so the culprit is always the top row. Ties fall back to
 *  memory then key, so the order does not shuffle between samples. */
function byLoad<T extends { cpuPct: number | null; memBytes: number; key: string }>(a: T, b: T) {
  const d = (b.cpuPct ?? -1) - (a.cpuPct ?? -1);
  if (d !== 0) return d;
  if (b.memBytes !== a.memBytes) return b.memBytes - a.memBytes;
  return a.key.localeCompare(b.key);
}

function byGroupLoad(a: { cpuPct: number | null; memBytes: number }, b: { cpuPct: number | null; memBytes: number }) {
  const d = (b.cpuPct ?? -1) - (a.cpuPct ?? -1);
  if (d !== 0) return d;
  return b.memBytes - a.memBytes;
}

/** Build `tabId -> title` from every task's persisted tab metadata. The
 *  Activity window is a SEPARATE webview, so it cannot read the main
 *  window's in-memory tab list; the persisted titles are what both windows
 *  agree on. */
export function tabTitleMap(tasks: Task[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tasks) {
    for (const tab of t.persisted_tabs ?? []) {
      if (tab.title) out.set(tab.id, tab.title);
    }
  }
  return out;
}

export function groupRows(rows: ProcRow[], projects: Project[], tasks: Task[]): Grouped {
  const tabTitles = tabTitleMap(tasks);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const projectById = new Map(projects.map(p => [p.id, p]));

  const decorated: ActivityRow[] = rows.map(r => ({ ...r, title: rowTitle(r, tabTitles) }));

  const self = decorated.filter(isSelfRow).sort(byLoad);
  const orphans: ActivityRow[] = [];
  // projectId -> taskId -> rows. A task whose project is gone lands under
  // a synthetic project keyed by "" so its rows stay visible.
  const tree = new Map<string, Map<string, ActivityRow[]>>();

  for (const row of decorated) {
    if (isSelfRow(row)) continue;
    if (!row.taskId) {
      orphans.push(row);
      continue;
    }
    const task = taskById.get(row.taskId);
    const projectId = task?.project_id ?? "";
    if (!tree.has(projectId)) tree.set(projectId, new Map());
    const byTask = tree.get(projectId)!;
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
    byTask.get(row.taskId)!.push(row);
  }

  const projectGroups: ProjectGroup[] = [];
  for (const [projectId, byTask] of tree) {
    const taskGroups: TaskGroup[] = [];
    for (const [taskId, taskRows] of byTask) {
      const task = taskById.get(taskId);
      taskRows.sort(byLoad);
      taskGroups.push({
        taskId,
        // An archived-mid-session task keeps its rows; naming it after the
        // id is uglier than a name but better than losing the group.
        taskName: task?.name ?? taskId,
        branch: task?.branch ?? null,
        rows: taskRows,
        cpuPct: sumCpu(taskRows),
        memBytes: sumMem(taskRows),
      });
    }
    taskGroups.sort(byGroupLoad);
    const flat = taskGroups.flatMap(g => g.rows);
    projectGroups.push({
      projectId,
      projectName: projectById.get(projectId)?.name ?? "Unknown project",
      tasks: taskGroups,
      cpuPct: sumCpu(flat),
      memBytes: sumMem(flat),
    });
  }
  projectGroups.sort(byGroupLoad);
  orphans.sort(byLoad);

  return {
    projects: projectGroups,
    self,
    selfCpuPct: sumCpu(self),
    selfMemBytes: sumMem(self),
    orphans,
    totalCpuPct: sumCpu(decorated),
    totalMemBytes: sumMem(decorated),
  };
}

// ───────────────────────────── formatting ─────────────────────────────

/** Binary units, matching what Activity Monitor shows. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${Math.round(n / 1024)} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** A dash for "no reading yet" is deliberate: the first sample of a
 *  session has no delta, and printing 0% there would claim the process is
 *  idle when we simply have not measured it. */
export function formatPct(n: number | null): string {
  if (n === null) return "–";
  if (n < 0.05) return "0%";
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
}

export function formatRate(n: number | null): string {
  if (n === null) return "–";
  if (n < 1) return "0";
  if (n < 1024) return `${Math.round(n)} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB/s`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
