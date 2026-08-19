import { describe, it, expect } from "vitest";
import {
  groupRows, rowTitle, tabTitleMap, isSelfRow,
  formatBytes, formatPct, formatRate, formatDuration,
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

  it("keeps row order stable when CPU and memory tie", () => {
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
  const titles = new Map([["tab-1", "review PR"], ["tab-blank", "   "]]);

  it("prefers the tab's persisted title", () => {
    expect(rowTitle(row({ tabId: "tab-1" }), titles)).toBe("review PR");
  });

  it("falls back to kind and process name", () => {
    expect(rowTitle(row({ tabId: "unknown", kind: "agent", label: "claude" }), titles)).toBe("Agent · claude");
    expect(rowTitle(row({ kind: "run", label: "npm" }), titles)).toBe("Run script · npm");
    expect(rowTitle(row({ kind: "setup", label: "sh" }), titles)).toBe("Setup script · sh");
  });

  it("ignores a whitespace-only persisted title", () => {
    expect(rowTitle(row({ tabId: "tab-blank", kind: "shell", label: "zsh" }), titles)).toBe("Shell · zsh");
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
  it("collects titled persisted tabs across tasks and skips untitled ones", () => {
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
    expect([...m.entries()]).toEqual([["a", "fix build"], ["d", "docs"]]);
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
