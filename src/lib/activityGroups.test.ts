import { describe, it, expect } from "vitest";
import {
  groupRows, rowTitle, tabTitleMap, isSelfRow, nextSort, smoothedCpu, DEFAULT_SORT,
  formatBytes, formatPct, formatRate, formatDuration,
  type Sort,
} from "@/lib/activityGroups";
import type { ProcRow } from "@/lib/ipc";
import type { Project, Task } from "@/lib/types";

function row(over: Partial<ProcRow> = {}): ProcRow {
  return {
    key: over.key ?? "pty:1",
    kind: "agent",
    ptyId: "1",
    taskId: null,
    tabId: null,
    pid: 100,
    label: "claude",
    cpuPct: 0,
    memBytes: 0,
    rssBytes: 0,
    procCount: 1,
    threads: 1,
    cpuMs: 0,
    uptimeMs: 0,
    outBps: null,
    alive: true,
    cpuHistory: [],
    children: [],
    ...over,
  };
}

function task(over: Partial<Task> & { id: string; project_id: string }): Task {
  return {
    name: over.id, branch: "b", base_branch: "main", path: "/tmp",
    cli: "claude", port: 3000, created: "", archived: false,
    ...over,
  } as Task;
}

const projects: Project[] = [
  { id: "p1", name: "termic" } as Project,
  { id: "p2", name: "website" } as Project,
];
const tasks: Task[] = [
  task({ id: "t1", project_id: "p1", name: "Montreal", branch: "montreal" }),
  task({ id: "t2", project_id: "p1", name: "Paris", branch: "paris" }),
  task({ id: "t3", project_id: "p2", name: "Copy tweaks", branch: "copy" }),
];

describe("groupRows", () => {
  it("nests rows under project then task", () => {
    const g = groupRows(
      [
        row({ key: "a", taskId: "t1", cpuPct: 10, memBytes: 100 }),
        row({ key: "b", taskId: "t3", cpuPct: 5, memBytes: 50 }),
      ],
      projects, tasks,
    );
    expect(g.projects.map(p => p.projectName)).toEqual(["termic", "website"]);
    expect(g.projects[0].tasks[0].taskName).toBe("Montreal");
    expect(g.projects[0].tasks[0].branch).toBe("montreal");
    expect(g.projects[0].tasks[0].rows.map(r => r.key)).toEqual(["a"]);
  });

  it("sorts projects, tasks and rows by CPU so the culprit is on top", () => {
    const g = groupRows(
      [
        row({ key: "quiet", taskId: "t2", cpuPct: 1 }),
        row({ key: "hog", taskId: "t1", cpuPct: 180 }),
        row({ key: "hog-sibling", taskId: "t1", cpuPct: 4 }),
        row({ key: "other-project", taskId: "t3", cpuPct: 60 }),
      ],
      projects, tasks,
    );
    // termic (184%) outranks website (60%).
    expect(g.projects[0].projectName).toBe("termic");
    // Within termic, Montreal (184%) outranks Paris (1%).
    expect(g.projects[0].tasks[0].taskName).toBe("Montreal");
    expect(g.projects[0].tasks[0].rows.map(r => r.key)).toEqual(["hog", "hog-sibling"]);
    expect(g.projects[0].tasks[0].cpuPct).toBe(184);
  });

  it("keeps row order stable when everything about two rows ties", () => {
    const a = groupRows([
      row({ key: "z", taskId: "t1", cpuPct: 3, memBytes: 10 }),
      row({ key: "a", taskId: "t1", cpuPct: 3, memBytes: 10 }),
    ], projects, tasks);
    const b = groupRows([
      row({ key: "a", taskId: "t1", cpuPct: 3, memBytes: 10 }),
      row({ key: "z", taskId: "t1", cpuPct: 3, memBytes: 10 }),
    ], projects, tasks);
    expect(a.projects[0].tasks[0].rows.map(r => r.key)).toEqual(["a", "z"]);
    expect(b.projects[0].tasks[0].rows.map(r => r.key)).toEqual(["a", "z"]);
  });

  it("separates Termic's own processes from spawned ones", () => {
    const g = groupRows(
      [
        row({ key: "app", kind: "app", ptyId: null, cpuPct: 4, memBytes: 300 }),
        row({ key: "webkit:WebContent", kind: "webkit-webcontent", ptyId: null, cpuPct: 2, memBytes: 700 }),
        row({ key: "agent", taskId: "t1", cpuPct: 90, memBytes: 400 }),
      ],
      projects, tasks,
    );
    expect(g.self.map(r => r.key)).toEqual(["app", "webkit:WebContent"]);
    expect(g.selfCpuPct).toBe(6);
    expect(g.selfMemBytes).toBe(1000);
    // Self rows are NOT inside any project group.
    expect(g.projects.flatMap(p => p.tasks.flatMap(t => t.rows)).map(r => r.key)).toEqual(["agent"]);
    // Totals still cover everything on screen.
    expect(g.totalCpuPct).toBe(96);
    expect(g.totalMemBytes).toBe(1400);
  });

  it("surfaces rows with no task instead of dropping them", () => {
    const g = groupRows([row({ key: "loose", taskId: null, kind: "shell", cpuPct: 70 })], projects, tasks);
    expect(g.orphans.map(r => r.key)).toEqual(["loose"]);
    expect(g.projects).toHaveLength(0);
    expect(g.totalCpuPct).toBe(70);
  });

  it("keeps rows for a task that was archived mid-session", () => {
    const g = groupRows([row({ key: "ghost", taskId: "gone", cpuPct: 12 })], projects, tasks);
    expect(g.projects[0].projectName).toBe("Unknown project");
    // Better an ugly id than a vanished CPU hog.
    expect(g.projects[0].tasks[0].taskName).toBe("gone");
    expect(g.projects[0].tasks[0].branch).toBeNull();
  });

  it("reports null CPU only while NO row has a reading yet", () => {
    const first = groupRows([
      row({ key: "a", taskId: "t1", cpuPct: null }),
      row({ key: "b", taskId: "t1", cpuPct: null }),
    ], projects, tasks);
    expect(first.projects[0].tasks[0].cpuPct).toBeNull();
    expect(first.totalCpuPct).toBeNull();

    // One row reporting is enough: a group must not claim 0% then.
    const mixed = groupRows([
      row({ key: "a", taskId: "t1", cpuPct: null }),
      row({ key: "b", taskId: "t1", cpuPct: 30 }),
    ], projects, tasks);
    expect(mixed.projects[0].tasks[0].cpuPct).toBe(30);
  });

  it("handles an empty snapshot", () => {
    const g = groupRows([], projects, tasks);
    expect(g).toMatchObject({ projects: [], self: [], orphans: [], totalCpuPct: null, totalMemBytes: 0 });
  });
});

describe("isSelfRow", () => {
  it("claims the app and every webkit sidecar, nothing else", () => {
    expect(isSelfRow(row({ kind: "app" }))).toBe(true);
    expect(isSelfRow(row({ kind: "webkit-gpu" }))).toBe(true);
    expect(isSelfRow(row({ kind: "webkit-networking" }))).toBe(true);
    expect(isSelfRow(row({ kind: "agent" }))).toBe(false);
    expect(isSelfRow(row({ kind: "shell" }))).toBe(false);
  });
});

describe("rowTitle", () => {
  const titles = new Map([
    ["tab-1", { title: "review PR" }],
    ["tab-blank", { title: "   " }],
    ["tab-claude", { cli: "claude" }],
    ["tab-shell", { cli: "shell" }],
    ["tab-claude-2", { cli: "claude", order: 2 }],
  ]);

  it("prefers the tab's persisted title", () => {
    expect(rowTitle(row({ tabId: "tab-1" }), titles)).toBe("review PR");
  });

  it("falls back to kind and process name", () => {
    expect(rowTitle(row({ tabId: "unknown", kind: "agent", label: "claude" }), titles)).toBe("Agent · claude");
    expect(rowTitle(row({ kind: "run", label: "npm" }), titles)).toBe("Run script · npm");
    expect(rowTitle(row({ kind: "setup", label: "sh" }), titles)).toBe("Setup script · sh");
  });

  it("names an agent after its CLI, not its process name", () => {
    // claude's process IS its version string ("2.1.235", same as macOS
    // Activity Monitor shows), which is useless as a row label.
    expect(rowTitle(row({ tabId: "tab-claude", kind: "agent", label: "2.1.235" }), titles))
      .toBe("Agent · claude");
    // A persisted title still wins over the CLI.
    expect(rowTitle(row({ tabId: "tab-1", kind: "agent", label: "2.1.235" }), titles))
      .toBe("review PR");
    // "shell" is the sentinel for a non-agent tab, never a name to print.
    expect(rowTitle(row({ tabId: "tab-shell", kind: "shell", label: "zsh" }), titles))
      .toBe("Shell · zsh");
  });

  it("ignores a whitespace-only persisted title", () => {
    expect(rowTitle(row({ tabId: "tab-blank", kind: "shell", label: "zsh" }), titles)).toBe("Shell · zsh");
  });

  it("names an unrenamed agent tab by its position, not the generic 'Agent' word", () => {
    // Several tabs in one task can run the same CLI ("Agent · claude" x5,
    // told apart only by PID) — the tab's position among its task's own
    // tabs replaces that generic word instead.
    expect(rowTitle(row({ tabId: "tab-claude-2", kind: "agent", label: "2.1.235" }), titles))
      .toBe("Tab 2 · claude");
    // No position known (e.g. the tab isn't in the metadata map at all) ->
    // falls back to the generic word, same as before.
    expect(rowTitle(row({ tabId: "tab-claude", kind: "agent", label: "2.1.235" }), titles))
      .toBe("Agent · claude");
  });

  it("drops the process name when it is unknown", () => {
    expect(rowTitle(row({ kind: "aux", label: "?" }), titles)).toBe("Terminal");
  });

  it("names the right panel's footer shell", () => {
    expect(rowTitle(row({ tabId: "right-footer", kind: "aux" }), titles)).toBe("Panel terminal");
  });

  it("spells the webkit sidecars the way Activity Monitor does", () => {
    expect(rowTitle(row({ kind: "webkit-webcontent" }), titles)).toBe("WebContent");
    expect(rowTitle(row({ kind: "webkit-gpu" }), titles)).toBe("GPU");
    expect(rowTitle(row({ kind: "webkit-networking" }), titles)).toBe("Networking");
  });
});

describe("tabTitleMap", () => {
  it("collects each persisted tab's title and CLI across tasks", () => {
    const m = tabTitleMap([
      task({
        id: "t1", project_id: "p1",
        persisted_tabs: [
          { id: "a", cli: "claude", title: "fix build" },
          { id: "b", cli: "claude", title: null },
          { id: "c", cli: "shell" },
        ],
      }),
      task({ id: "t2", project_id: "p1", persisted_tabs: [{ id: "d", cli: "gemini", title: "docs" }] }),
      task({ id: "t3", project_id: "p1" }),
    ]);
    // An untitled tab still contributes its CLI — that is the whole point of
    // carrying the metadata rather than just titles. `order` is 1-based and
    // restarts per task (t1's 3 tabs are 1/2/3; t2's lone tab is 1, not 4).
    expect(m.get("a")).toEqual({ title: "fix build", cli: "claude", order: 1 });
    expect(m.get("b")).toEqual({ title: undefined, cli: "claude", order: 2 });
    expect(m.get("c")).toEqual({ title: undefined, cli: "shell", order: 3 });
    expect(m.get("d")).toEqual({ title: "docs", cli: "gemini", order: 1 });
    expect(m.size).toBe(4);
  });

  it("prefers a bridged live title over the persisted (on-rename-only) one", () => {
    // liveTitles comes from the main window (activityTitleBridge.ts) and
    // covers every live tab, not just renamed ones — "b" has no persisted
    // title at all, but still gets a real name once the bridge answers.
    const m = tabTitleMap(
      [task({
        id: "t1", project_id: "p1",
        persisted_tabs: [
          { id: "a", cli: "claude", title: "fix build" },
          { id: "b", cli: "claude", title: null },
        ],
      })],
      { a: "Claude Code", b: "Action Required" },
    );
    expect(m.get("a")?.title).toBe("Claude Code");
    expect(m.get("b")?.title).toBe("Action Required");
  });
});

describe("sorting", () => {
  const busy = (over: Partial<ProcRow>) => row(over);

  it("defaults to CPU descending", () => {
    expect(DEFAULT_SORT).toEqual({ column: "cpu", dir: "desc" });
  });

  it("orders CPU on a short average, so jitter cannot swap near-equal rows", () => {
    // Two rows whose instantaneous values just crossed, but whose recent
    // history says which one is actually the hog. Ordering on the instant
    // would swap them this tick and swap them back the next.
    const hog = busy({ key: "hog", taskId: "t1", cpuPct: 40, cpuHistory: [95, 96, 94, 92] });
    const quiet = busy({ key: "quiet", taskId: "t1", cpuPct: 42, cpuHistory: [3, 4, 2, 5] });
    const g = groupRows([quiet, hog], projects, tasks);
    expect(g.projects[0].tasks[0].rows.map(r => r.key)).toEqual(["hog", "quiet"]);
    // The DISPLAYED value stays instantaneous — only the order is smoothed.
    expect(g.projects[0].tasks[0].rows[0].cpuPct).toBe(40);
  });

  it("smoothedCpu averages the recent window and falls back to the instant", () => {
    expect(smoothedCpu({ cpuPct: 50, cpuHistory: [] })).toBe(50);
    expect(smoothedCpu({ cpuPct: null, cpuHistory: [] })).toBe(0);
    expect(smoothedCpu({ cpuPct: 0, cpuHistory: [100, 0, 100, 0] })).toBe(50);
    // Only the last 4 samples count, so an old spike ages out.
    expect(smoothedCpu({ cpuPct: 0, cpuHistory: [999, 10, 10, 10, 10] })).toBe(10);
  });

  const sorted = (s: Sort) => {
    const g = groupRows(
      [
        busy({ key: "a", taskId: "t1", cpuPct: 5, cpuHistory: [5], memBytes: 300, outBps: 10, procCount: 9, uptimeMs: 1000 }),
        busy({ key: "b", taskId: "t1", cpuPct: 50, cpuHistory: [50], memBytes: 100, outBps: 999, procCount: 1, uptimeMs: 5000 }),
        busy({ key: "c", taskId: "t1", cpuPct: 20, cpuHistory: [20], memBytes: 200, outBps: null, procCount: 4, uptimeMs: 300 }),
      ],
      projects, tasks, s,
    );
    return g.projects[0].tasks[0].rows.map(r => r.key);
  };

  it("sorts by every column, both directions", () => {
    expect(sorted({ column: "cpu", dir: "desc" })).toEqual(["b", "c", "a"]);
    expect(sorted({ column: "cpu", dir: "asc" })).toEqual(["a", "c", "b"]);
    expect(sorted({ column: "mem", dir: "desc" })).toEqual(["a", "c", "b"]);
    expect(sorted({ column: "mem", dir: "asc" })).toEqual(["b", "c", "a"]);
    expect(sorted({ column: "uptime", dir: "desc" })).toEqual(["b", "a", "c"]);
    // An unmeasured output rate sorts BELOW a real zero, not above everything.
    expect(sorted({ column: "out", dir: "desc" })).toEqual(["b", "a", "c"]);
  });

  it("sorts by name using the resolved row title", () => {
    const g = groupRows(
      [
        busy({ key: "z", taskId: "t1", tabId: "tz", kind: "shell", label: "zsh" }),
        busy({ key: "a", taskId: "t1", tabId: "ta", kind: "agent", label: "claude" }),
      ],
      projects, tasks, { column: "name", dir: "asc" },
    );
    expect(g.projects[0].tasks[0].rows.map(r => r.title)).toEqual(["Agent · claude", "Shell · zsh"]);
  });

  it("sorts the project and task groups by the same column", () => {
    const g = groupRows(
      [
        busy({ key: "small", taskId: "t1", cpuPct: 1, cpuHistory: [1], memBytes: 10 }),
        busy({ key: "big", taskId: "t3", cpuPct: 1, cpuHistory: [1], memBytes: 900 }),
      ],
      projects, tasks, { column: "mem", dir: "desc" },
    );
    // website (900) outranks termic (10) because memory is the active column.
    expect(g.projects.map(p => p.projectName)).toEqual(["website", "termic"]);
  });

  it("orders identically-named rows deterministically", () => {
    // Two idle claude tabs in one task have the same title AND the same
    // numbers in every column. With nothing left to separate them the order
    // falls back to the snapshot's own order, which is Rust HashMap iteration
    // order and reshuffles every sample — the visible symptom being rows that
    // swap places while nothing is happening. The key tie-break fixes it.
    const twins = (order: string[]) =>
      groupRows(
        order.map(k => busy({ key: k, taskId: "t1", kind: "agent", label: "claude", cpuPct: 0, cpuHistory: [0] })),
        projects, tasks,
      ).projects[0].tasks[0].rows.map(r => r.key);
    expect(twins(["pty:b", "pty:a"])).toEqual(["pty:a", "pty:b"]);
    expect(twins(["pty:a", "pty:b"])).toEqual(["pty:a", "pty:b"]);
  });
});

describe("nextSort", () => {
  it("flips direction on the active column", () => {
    expect(nextSort({ column: "cpu", dir: "desc" }, "cpu")).toEqual({ column: "cpu", dir: "asc" });
    expect(nextSort({ column: "cpu", dir: "asc" }, "cpu")).toEqual({ column: "cpu", dir: "desc" });
  });

  it("starts a numeric column biggest-first and the name column A-to-Z", () => {
    expect(nextSort({ column: "cpu", dir: "asc" }, "mem")).toEqual({ column: "mem", dir: "desc" });
    expect(nextSort({ column: "cpu", dir: "asc" }, "name")).toEqual({ column: "name", dir: "asc" });
  });
});

describe("formatters", () => {
  it("formats memory in binary units", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });

  it("shows a dash for an unmeasured percentage, never a zero", () => {
    // The first sample of a session has no delta; 0% would be a claim we
    // have not earned.
    expect(formatPct(null)).toBe("–");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(3.14)).toBe("3.1%");
    expect(formatPct(143.6)).toBe("144%");
  });

  it("formats output rate", () => {
    expect(formatRate(null)).toBe("–");
    expect(formatRate(0)).toBe("0");
    expect(formatRate(900)).toBe("900 B/s");
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatRate(3 * 1024 * 1024)).toBe("3.0 MB/s");
  });

  it("formats uptime", () => {
    expect(formatDuration(0)).toBe("–");
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});
