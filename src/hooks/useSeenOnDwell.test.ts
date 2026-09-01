import { describe, it, expect, beforeEach } from "vitest";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { dwellTarget } from "@/hooks/useSeenOnDwell";
import type { Task, Tab } from "@/lib/types";

const task = (id: string): Task => ({
  id, project_id: "p", name: id, path: `/tmp/${id}`, branch: "main",
  cli: "claude", created_at: "", archived: false,
} as unknown as Task);

const tab = (id: string, unread: Tab["unread"]): Tab => ({
  id, type: "terminal", cli: "claude", title: id, unread,
} as unknown as Tab);

describe("dwellTarget", () => {
  beforeEach(() => {
    useUI.setState({ windowless: false } as never);
    useApp.setState({
      tasks: [task("t1"), task("t2")],
      activeTaskId: "t1",
      tabs: { t1: [tab("a", { reason: "attention" })], t2: [tab("b", { reason: "done" })] },
      activeTab: { t1: "a", t2: "b" },
      splitTree: {}, activePaneId: {},
    } as never);
  });

  it("names the badged tab the user is actually looking at", () => {
    expect(dwellTarget(useApp.getState())).toBe("t1:a");
  });

  it("ignores a badge on a task the user is not on", () => {
    // t2's badge is the whole point of badges. Clearing it would destroy the
    // signal instead of acknowledging it.
    useApp.setState({ activeTaskId: "t2" } as never);
    expect(dwellTarget(useApp.getState())).toBe("t2:b");
    useApp.setState({ activeTaskId: "t1" } as never);
    expect(dwellTarget(useApp.getState())).toBe("t1:a");
  });

  it("names nothing when the visible tab has no badge", () => {
    useApp.setState({ tabs: { ...useApp.getState().tabs, t1: [tab("a", null)] } } as never);
    expect(dwellTarget(useApp.getState())).toBe("");
  });

  it("is PURE in the app store, so presence is the hook's to apply", () => {
    // Deliberately still names the tab while windowless. Folding presence in
    // here would be worse than redundant: a `useApp` selector does not re-run
    // when `useUI` changes, so a target that baked in focus would stay stale
    // at "" after the user came back and the badge would never clear.
    useUI.setState({ windowless: true, windowFocused: false } as never);
    expect(dwellTarget(useApp.getState())).toBe("t1:a");
  });

  it("names nothing when no task is active", () => {
    useApp.setState({ activeTaskId: null } as never);
    expect(dwellTarget(useApp.getState())).toBe("");
  });

  it("returns a primitive, so the selector cannot churn subscribers", () => {
    // A fresh object here would re-run every store subscriber on every write.
    // See src/store/selectorFanout.test.ts for why that is a gating concern.
    expect(typeof dwellTarget(useApp.getState())).toBe("string");
  });
});
