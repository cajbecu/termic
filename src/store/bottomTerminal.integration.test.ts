// @vitest-environment happy-dom
//
// Focus rules of the bottom (aux) terminal split, driven through the REAL
// store. The rules live in `toggleBottomTerminal` / `addBottomTab`, not in the
// callers, and they split into two opposite cases that a naive fix breaks:
//
//   - The user opens the panel (⌘J, the palette, the footer "Terminal"
//     button) → the shell MUST take focus, or the user clicks twice to type.
//   - TaskView's seed effect restores a persisted split on launch → the shell
//     must NOT take focus, or every launch steals it from the agent pane.
//
// AuxTerminal self-focuses off the `autoFocus` flag on the tab record, so the
// flag is the observable that both cases turn on.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useApp } from "@/store/app";
import { focusTerminalTab, focusMainTab } from "@/lib/tabFocus";

const bottom = (taskId = "ws1") => useApp.getState().bottomTabs[taskId] ?? [];

beforeEach(() => {
  useApp.setState({
    bottomTabs: {}, activeBottomTab: {}, activeTab: {}, tabs: {},
    terminalSplit: {}, terminalSplitCollapsed: {}, splitTree: {}, activePaneId: {},
    tasks: [], projects: [], agents: [], activeTaskId: "ws1",
    mountedTasks: new Set(),
  });
  localStorage.clear();
  vi.clearAllMocks();
});

describe("toggleBottomTerminal", () => {
  it("opens the split, seeds one shell, and marks it for focus", () => {
    useApp.getState().toggleBottomTerminal("ws1");

    expect(useApp.getState().terminalSplit["ws1"]).toBe(true);
    expect(bottom()).toHaveLength(1);
    expect(bottom()[0].autoFocus).toBe(true);
    expect(useApp.getState().activeBottomTab["ws1"]).toBe(bottom()[0].id);
    expect(focusTerminalTab).toHaveBeenCalledWith(bottom()[0].id);
  });

  it("expands a collapsed split without adding a second shell", () => {
    useApp.getState().toggleBottomTerminal("ws1");
    const id = bottom()[0].id;
    useApp.getState().toggleTerminalSplitCollapsed("ws1");
    vi.clearAllMocks();

    useApp.getState().toggleBottomTerminal("ws1");

    expect(useApp.getState().terminalSplitCollapsed["ws1"]).toBe(false);
    expect(bottom()).toHaveLength(1);
    expect(focusTerminalTab).toHaveBeenCalledWith(id);
  });

  it("moves focus into an already open split instead of collapsing it", () => {
    useApp.getState().toggleBottomTerminal("ws1");
    const id = bottom()[0].id;
    vi.clearAllMocks();

    // Focus sits outside the split (happy-dom leaves it on <body>).
    useApp.getState().toggleBottomTerminal("ws1");

    expect(useApp.getState().terminalSplitCollapsed["ws1"]).toBeFalsy();
    expect(focusTerminalTab).toHaveBeenCalledWith(id);
  });

  it("collapses and hands focus back when the split already owns focus", () => {
    useApp.getState().toggleBottomTerminal("ws1");
    useApp.setState({ activeTab: { ws1: "main-tab" } });

    const host = document.createElement("div");
    host.setAttribute("data-bottom-split", "");
    const input = document.createElement("input");
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();
    vi.clearAllMocks();

    useApp.getState().toggleBottomTerminal("ws1");

    expect(useApp.getState().terminalSplitCollapsed["ws1"]).toBe(true);
    // Collapsed, not closed: the shells and their PTYs stay mounted.
    expect(bottom()).toHaveLength(1);
    expect(focusMainTab).toHaveBeenCalledWith("main-tab");

    document.body.removeChild(host);
  });
});

describe("addBottomTab focus flag", () => {
  it("defaults to taking focus", () => {
    useApp.getState().addBottomTab("ws1");
    expect(bottom()[0].autoFocus).toBe(true);
  });

  it("leaves the launch-restored shell unfocused", () => {
    useApp.getState().addBottomTab("ws1", { focus: false });
    expect(bottom()[0].autoFocus).toBe(false);
    expect(focusTerminalTab).not.toHaveBeenCalled();
  });
});
