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

/** Column aggregates, so a group sorts by the same column its rows do. */
export interface Totals {
  cpuPct: number | null;
  /** Sort key for CPU: see `smoothedCpu`. */
  cpuSort: number;
  memBytes: number;
  outBps: number | null;
  uptimeMs: number;
  /** A group has no pid of its own; it sorts by its lowest one, which is the
   *  closest thing to "the oldest process in here". */
  pid: number;
}

export interface TaskGroup extends Totals {
  taskId: string;
  /** Task name, or the raw id when the task is gone (archived mid-session). */
  taskName: string;
  branch: string | null;
  rows: ActivityRow[];
}

export interface ProjectGroup extends Totals {
  projectId: string;
  projectName: string;
  tasks: TaskGroup[];
}

export const SORT_COLUMNS = ["name", "cpu", "mem", "out", "uptime", "pid"] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export interface Sort {
  column: SortColumn;
  dir: "asc" | "desc";
}
/** CPU descending: the question the window exists to answer. */
export const DEFAULT_SORT: Sort = { column: "cpu", dir: "desc" };

/** Clicking a column: same column flips direction, a new column starts in the
 *  direction that column is usually read in — biggest-first for the numbers,
 *  A-to-Z for the name. */
export function nextSort(current: Sort, column: SortColumn): Sort {
  if (current.column === column) {
    return { column, dir: current.dir === "desc" ? "asc" : "desc" };
  }
  return { column, dir: column === "name" ? "asc" : "desc" };
}

/** The CPU value rows are ORDERED by, which is deliberately not the value
 *  they DISPLAY. Instantaneous CPU jitters by a few percent every second, and
 *  ordering on it makes near-equal rows trade places on every tick — the
 *  table becomes unreadable exactly when several agents are busy. Averaging
 *  the last few samples keeps a real hog on top while leaving the display
 *  honest about right now. */
export function smoothedCpu(row: { cpuPct: number | null; cpuHistory: number[] }): number {
  const recent = row.cpuHistory.slice(-4);
  if (recent.length === 0) return row.cpuPct ?? 0;
  return recent.reduce((a, v) => a + v, 0) / recent.length;
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

/** What we know about a tab from the task's persisted metadata: the Activity
 *  window is a SEPARATE webview, so it cannot read the main window's live tab
 *  list — this is what both windows agree on. */
export interface TabMeta {
  title?: string;
  /** Agent id for the tab ("claude" / "gemini" / …), or "shell". */
  cli?: string;
  /** 1-based position among the task's OWN persisted tabs, in stored
   *  (display) order. A task can run several tabs on the SAME cli — "Agent
   *  · claude" x5, indistinguishable except by PID — so an unrenamed agent
   *  tab falls back to "Tab <order>" instead of the generic "Agent" word,
   *  which at least tells them apart. */
  order?: number;
}

/** Row title. Prefers the tab's persisted title (what the user sees on the
 *  tab strip), then — for an agent row — a positional "Tab N" paired with
 *  its CLI, then the kind plus the process name for everything else.
 *
 *  The agent id matters because a CLI's process name is not its name: claude
 *  runs as its version string, so the honest process name is `2.1.235` (macOS
 *  Activity Monitor shows the same thing) and a table of those is unreadable.
 *  The real process name stays in the row's tooltip. */
export function rowTitle(row: ProcRow, tabTitles: Map<string, TabMeta>): string {
  if (row.kind.startsWith("webkit-")) {
    // "webkit-webcontent" -> "WebContent" (the label Rust derived from the
    // XPC service's path, since every one of them reports the same comm).
    const raw = row.kind.slice("webkit-".length);
    return raw === "webcontent" ? "WebContent"
      : raw === "gpu" ? "GPU"
      : raw === "networking" ? "Networking"
      : raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  const meta = row.tabId ? tabTitles.get(row.tabId) : undefined;
  const persisted = meta?.title?.trim();
  if (persisted) return persisted;
  if (row.tabId === "right-footer") return "Panel terminal";
  const cli = meta?.cli?.trim();
  if (row.kind === "agent" && cli && cli !== "shell") {
    const name = meta?.order ? `Tab ${meta.order}` : "Agent";
    return `${name} · ${cli}`;
  }
  const kind = KIND_LABELS[row.kind] ?? row.kind;
  // The process name adds information only when it differs from the kind
  // ("Shell · zsh" is less useful than "Agent · claude" was, but still honest,
  // and a task rarely runs two of the same non-agent kind at once).
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

/** Column aggregates for a group: each column's group value is whatever makes
 *  sense for it, so sorting by a column orders groups the way it orders rows. */
function totals(rows: ActivityRow[]): Totals {
  const outKnown = rows.filter(r => r.outBps !== null);
  return {
    cpuPct: sumCpu(rows),
    cpuSort: rows.reduce((a, r) => a + smoothedCpu(r), 0),
    memBytes: rows.reduce((a, r) => a + r.memBytes, 0),
    outBps: outKnown.length ? outKnown.reduce((a, r) => a + (r.outBps ?? 0), 0) : null,
    // Oldest thing in the group: a task is as old as its longest-lived process.
    uptimeMs: rows.reduce((a, r) => Math.max(a, r.uptimeMs), 0),
    pid: rows.reduce((a, r) => Math.min(a, r.pid), Number.MAX_SAFE_INTEGER),
  };
}

/** The value a given column sorts on. Numbers only; `name` is compared
 *  separately so it can use a locale collation. */
function sortValue(v: Totals, column: SortColumn): number {
  switch (column) {
    case "cpu": return v.cpuSort;
    case "mem": return v.memBytes;
    case "out": return v.outBps ?? -1;
    case "uptime": return v.uptimeMs;
    case "pid": return v.pid;
    case "name": return 0;
  }
}

/** What any level of the tree is sorted by: the column aggregates, a display
 *  name, and a stable identity. */
interface Sortable extends Totals {
  sortName: string;
  /** Final tie-break, and it must be TOTAL. Two rows can legitimately share a
   *  name (two claude tabs in one task, both idle at 0%), and with nothing
   *  left to separate them the comparator returns 0 — leaving them in the
   *  order the snapshot arrived in, which is Rust HashMap iteration order and
   *  therefore reshuffles on every single sample. */
  sortKey: string;
}

function rowSortable(r: ActivityRow): Sortable {
  return {
    cpuPct: r.cpuPct,
    cpuSort: smoothedCpu(r),
    memBytes: r.memBytes,
    outBps: r.outBps,
    uptimeMs: r.uptimeMs,
    pid: r.pid,
    sortName: r.title,
    sortKey: r.key,
  };
}

/** Comparator for one level of the tree. Every branch ends in a stable
 *  tie-break on the name, so equal values (two idle agents, or the whole
 *  table on the first sample) keep a fixed order instead of shuffling on
 *  every tick. */
function comparator(sort: Sort): (a: Sortable, b: Sortable) => number {
  const flip = sort.dir === "asc" ? -1 : 1;
  return (a, b) => {
    if (sort.column !== "name") {
      const d = sortValue(b, sort.column) - sortValue(a, sort.column);
      if (d !== 0) return flip * d;
    } else {
      const byName = flip * -a.sortName.localeCompare(b.sortName);
      if (byName !== 0) return byName;
    }
    return a.sortName.localeCompare(b.sortName) || a.sortKey.localeCompare(b.sortKey);
  };
}

/** Build `tabId -> { title, cli }` from every task's persisted tab metadata. */
/** `liveTitles` overlays the CURRENTLY DISPLAYED title (same value the tab
 *  strip shows — `tab.customTitle ? tab.title : (tab.liveTitle || tab.title)`,
 *  see TabBar.tsx) for whichever tabs the main window answered with, bridged
 *  in from the separate main-window webview (see
 *  src/lib/activityTitleBridge.ts — Activity cannot read another webview's
 *  Zustand state directly). Wins over the on-disk persisted title: it is
 *  strictly fresher, and covers every live tab, not just renamed ones. */
export function tabTitleMap(tasks: Task[], liveTitles?: Record<string, string>): Map<string, TabMeta> {
  const out = new Map<string, TabMeta>();
  for (const t of tasks) {
    (t.persisted_tabs ?? []).forEach((tab, i) => {
      // Order restarts at 1 per task — persisted_tabs is that task's own
      // array, so "Tab 2" means the second tab of THIS task, not a global count.
      out.set(tab.id, { title: liveTitles?.[tab.id] ?? tab.title ?? undefined, cli: tab.cli, order: i + 1 });
    });
  }
  // A tab the main window is showing but that has not reached disk yet (the
  // task list here is re-read from disk on its own slow cadence, and a
  // just-opened task's tabs are persisted asynchronously) still gets its
  // bridged title. Without this, `persisted_tabs` gates the overlay and such a
  // row reads "Agent · bash" — a live title we already have in hand, thrown
  // away because the tab was young.
  for (const [tabId, title] of Object.entries(liveTitles ?? {})) {
    if (!out.has(tabId)) out.set(tabId, { title });
  }
  return out;
}

export function groupRows(
  rows: ProcRow[],
  projects: Project[],
  tasks: Task[],
  sort: Sort = DEFAULT_SORT,
  liveTitles?: Record<string, string>,
): Grouped {
  const tabTitles = tabTitleMap(tasks, liveTitles);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const projectById = new Map(projects.map(p => [p.id, p]));

  const decorated: ActivityRow[] = rows.map(r => ({ ...r, title: rowTitle(r, tabTitles) }));
  // One comparator for every level: rows sort by their own values, groups by
  // the aggregates of the same column.
  const cmp = comparator(sort);
  const rowCmp = (a: ActivityRow, b: ActivityRow) => cmp(rowSortable(a), rowSortable(b));

  const self = [...decorated.filter(isSelfRow)].sort(rowCmp);
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
      taskRows.sort(rowCmp);
      taskGroups.push({
        taskId,
        // An archived-mid-session task keeps its rows; naming it after the
        // id is uglier than a name but better than losing the group.
        taskName: task?.name ?? taskId,
        branch: task?.branch ?? null,
        rows: taskRows,
        ...totals(taskRows),
      });
    }
    taskGroups.sort((a, b) =>
      cmp({ ...a, sortName: a.taskName, sortKey: a.taskId }, { ...b, sortName: b.taskName, sortKey: b.taskId }));
    const flat = taskGroups.flatMap(g => g.rows);
    const projectName = projectById.get(projectId)?.name ?? "Unknown project";
    projectGroups.push({
      projectId,
      projectName,
      tasks: taskGroups,
      ...totals(flat),
    });
  }
  projectGroups.sort((a, b) =>
    cmp(
      { ...a, sortName: a.projectName, sortKey: a.projectId },
      { ...b, sortName: b.projectName, sortKey: b.projectId },
    ),
  );
  orphans.sort(rowCmp);

  return {
    projects: projectGroups,
    self,
    selfCpuPct: sumCpu(self),
    selfMemBytes: totals(self).memBytes,
    orphans,
    totalCpuPct: sumCpu(decorated),
    totalMemBytes: totals(decorated).memBytes,
  };
}

/** The subtree's processes, for the row's tooltip. There is no expand
 *  affordance: for a single-process row (most rows) it only repeated the
 *  Process and PID columns. But WHICH child is burning the CPU is still the
 *  answer when an agent has forked a build, so it lives here instead. */
export function childSummary(row: ProcRow): string {
  const head = `${row.label} · pid ${row.pid}`;
  const kids = row.children
    .filter(c => c.pid !== row.pid)
    .map(c => `${c.label} ${c.pid} · ${formatPct(c.cpu_pct)} · ${formatBytes(c.mem_bytes)}`);
  if (kids.length === 0) return head;
  const hidden = row.procCount - row.children.length;
  return [head, ...kids, hidden > 0 ? `+${hidden} more` : ""].filter(Boolean).join("\n");
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
