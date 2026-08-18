import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  pushToast: vi.fn(),
  closeTab: vi.fn(),
  closePaneTab: vi.fn(),
  setConfirmBeforeCloseAgentTab: vi.fn(),
  tabs: [] as any[],
  closedTabs: {} as Record<string, any[]>,
  prefs: { confirmBeforeCloseAgentTab: true },
}));

vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({
      tabs: { t1: h.tabs },
      agents: [],
      closedTabs: h.closedTabs,
      closeTab: h.closeTab,
      closePaneTab: h.closePaneTab,
      resumeClosedTab: vi.fn(),
    }),
  },
}));
// The real ui/prefs stores touch `document` on import (theme application),
// which the node test environment has no answer for.
vi.mock("@/store/ui", () => ({
  useUI: { getState: () => ({ askConfirm: h.askConfirm, pushToast: h.pushToast }) },
}));
vi.mock("@/store/prefs", () => ({
  usePrefs: {
    getState: () => ({
      ...h.prefs,
      setConfirmBeforeCloseAgentTab: h.setConfirmBeforeCloseAgentTab,
    }),
  },
}));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: (cli: string) => cli,
  // Only "term" stands in for a registry terminal here; claude is an agent.
  isTerminalCli: (cli: string) => cli === "term",
}));

import { requestCloseTab, requestClosePaneTab } from "@/lib/closeTab";
import type { Tab } from "@/lib/types";

/** A terminal tab shaped enough for the confirm gate. */
const agentTab = (over: Partial<Tab> = {}): any => ({
  id: "tab1", type: "terminal", cli: "claude", ptyId: 7, is_default: true, ...over,
});

beforeEach(() => {
  h.askConfirm.mockReset().mockResolvedValue({ confirmed: true, checked: false, dontAskAgain: false });
  h.pushToast.mockReset();
  h.closeTab.mockReset();
  h.closePaneTab.mockReset();
  h.setConfirmBeforeCloseAgentTab.mockReset();
  h.closedTabs = {};
  h.prefs.confirmBeforeCloseAgentTab = true;
  h.tabs = [agentTab()];
});

// Issue #102: the close confirm carries the same opt-out as the archive one,
// and its copy stops implying loss for the closes that are one click from
// coming back.
describe("agent tab close confirm", () => {
  it("offers the opt-out and closes on confirm", async () => {
    await requestCloseTab("t1", "tab1");
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.dontAskAgain).toBe(true);
    // The old flow put the opt-out in the generic `checkbox` slot, which the
    // archive dialog uses for "delete the branch" — one meaning per slot.
    expect(req.checkbox).toBeUndefined();
    expect(h.closeTab).toHaveBeenCalledWith("t1", "tab1");
  });

  it("does not close when the user backs out", async () => {
    h.askConfirm.mockResolvedValue({ confirmed: false, checked: false, dontAskAgain: true });
    await requestCloseTab("t1", "tab1");
    expect(h.closeTab).not.toHaveBeenCalled();
    // Backing out with the box unticked must not disable future confirms:
    // the dialog reports the checkbox state at dismissal either way.
    expect(h.setConfirmBeforeCloseAgentTab).not.toHaveBeenCalled();
  });

  it("stores the opt-out only when the close went through", async () => {
    h.askConfirm.mockResolvedValue({ confirmed: true, checked: false, dontAskAgain: true });
    await requestCloseTab("t1", "tab1");
    expect(h.setConfirmBeforeCloseAgentTab).toHaveBeenCalledWith(false);
    expect(h.closeTab).toHaveBeenCalledWith("t1", "tab1");
  });

  it("skips the dialog and toasts the way back once opted out", async () => {
    h.prefs.confirmBeforeCloseAgentTab = false;
    h.tabs = [agentTab({ is_default: false })];
    h.closedTabs = { t1: [{ id: "entry1" }] };
    await requestCloseTab("t1", "tab1");
    expect(h.askConfirm).not.toHaveBeenCalled();
    expect(h.closeTab).toHaveBeenCalledWith("t1", "tab1");
    const [msg, , opts] = h.pushToast.mock.calls[0];
    expect(msg).toContain("Resume");
    expect(opts.action.label).toBe("Resume");
  });

  it("keeps the main tab's close soft: it auto-resumes", async () => {
    await requestCloseTab("t1", "tab1");
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.destructive).toBe(false);
    expect(req.message).toContain("resumes when you reopen the task");
  });

  it("points a secondary tab's close at the Resume list, not at loss", async () => {
    h.tabs = [agentTab({ is_default: false })];
    await requestCloseTab("t1", "tab1");
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.destructive).toBe(false);
    expect(req.message).toContain("Resume list");
  });

  it("still warns on a PANE tab, the one close with no way back", async () => {
    // Pane tabs are never snapshotted into closedTabs, so there is no Resume
    // entry afterwards — this close really is one-way.
    h.tabs = [agentTab({ id: "p1", is_default: false, paneId: "pane1" })];
    expect(await requestClosePaneTab("t1", "pane1", "p1")).toBe(true);
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.destructive).toBe(true);
    expect(req.message).toContain("can't be resumed");
    expect(h.closePaneTab).toHaveBeenCalledWith("t1", "pane1", "p1");
  });

  it("asks nothing for a shell tab", async () => {
    h.tabs = [agentTab({ cli: "shell" })];
    await requestCloseTab("t1", "tab1");
    expect(h.askConfirm).not.toHaveBeenCalled();
    expect(h.closeTab).toHaveBeenCalledWith("t1", "tab1");
  });

  it("asks nothing for a registry terminal whose process already exited", async () => {
    h.tabs = [agentTab({ cli: "term", ptyId: undefined })];
    await requestCloseTab("t1", "tab1");
    expect(h.askConfirm).not.toHaveBeenCalled();
    expect(h.closeTab).toHaveBeenCalledWith("t1", "tab1");
  });
});
