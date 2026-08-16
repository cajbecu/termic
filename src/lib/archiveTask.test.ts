import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  taskArchive: vi.fn(),
  loadAll: vi.fn(),
  setActiveTask: vi.fn(),
  askConfirm: vi.fn(),
  setBusy: vi.fn(),
  setConfirmBeforeArchiveTask: vi.fn(),
  setArchiveDeleteBranch: vi.fn(),
  state: { activeTaskId: null as string | null },
  prefs: { confirmBeforeArchiveTask: true, archiveDeleteBranch: false },
}));

vi.mock("@/lib/ipc", () => ({ taskArchive: h.taskArchive }));
vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({
      activeTaskId: h.state.activeTaskId,
      setActiveTask: h.setActiveTask,
      loadAll: h.loadAll,
    }),
  },
}));
// The real ui/prefs stores touch `document` on import (theme application),
// which the node test environment has no answer for.
vi.mock("@/store/ui", () => ({
  useUI: { getState: () => ({ askConfirm: h.askConfirm, setBusy: h.setBusy }) },
}));
vi.mock("@/store/prefs", () => ({
  usePrefs: {
    getState: () => ({
      ...h.prefs,
      setConfirmBeforeArchiveTask: h.setConfirmBeforeArchiveTask,
      setArchiveDeleteBranch: h.setArchiveDeleteBranch,
    }),
  },
}));

import { archiveAndRefresh, confirmAndArchive } from "@/lib/archiveTask";
import type { Task } from "@/lib/types";

/** Minimal Task shaped enough for the archive flow (name, branch, and which
 *  of the three prompt variants it takes). */
const task = (over: Partial<Task> = {}): Task => ({
  id: "w1", name: "show approvers", branch: "show-approvers",
  ...over,
} as Task);

beforeEach(() => {
  h.taskArchive.mockReset().mockResolvedValue(undefined);
  h.loadAll.mockReset().mockResolvedValue(undefined);
  h.setActiveTask.mockReset();
  h.askConfirm.mockReset().mockResolvedValue({ confirmed: true, checked: false, dontAskAgain: false });
  h.setBusy.mockReset();
  h.setConfirmBeforeArchiveTask.mockReset();
  h.setArchiveDeleteBranch.mockReset();
  h.state.activeTaskId = null;
  h.prefs.confirmBeforeArchiveTask = true;
  h.prefs.archiveDeleteBranch = false;
});

describe("archiveAndRefresh (issue #24)", () => {
  it("archives then refreshes on success", async () => {
    await archiveAndRefresh("w1", false);
    expect(h.taskArchive).toHaveBeenCalledWith("w1", false);
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });

  it("STILL refreshes when archive rejects on a cleanup error", async () => {
    // The bug: a best-effort cleanup failure (e.g. `git worktree remove`)
    // rejects the IPC even though the task is already marked archived.
    // The refresh must run anyway, or the sidebar stays stale until reload.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.taskArchive.mockRejectedValue(new Error("worktree remove: locked"));

    await expect(archiveAndRefresh("w1", false)).resolves.toBeUndefined();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled(); // the cleanup warning is surfaced, not swallowed silently
    spy.mockRestore();
  });

  it("deselects the task when it was the active one", async () => {
    h.state.activeTaskId = "w1";
    await archiveAndRefresh("w1", true);
    expect(h.setActiveTask).toHaveBeenCalledWith(null);
    expect(h.taskArchive).toHaveBeenCalledWith("w1", true);
  });

  it("leaves an unrelated active task selected", async () => {
    h.state.activeTaskId = "other";
    await archiveAndRefresh("w1", false);
    expect(h.setActiveTask).not.toHaveBeenCalled();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });
});

describe("confirmAndArchive", () => {
  it("asks first, and archives with the checkbox's branch answer", async () => {
    h.askConfirm.mockResolvedValue({ confirmed: true, checked: true, dontAskAgain: false });
    await confirmAndArchive(task());

    const req = h.askConfirm.mock.calls[0][0];
    expect(req.title).toBe('Archive "show approvers"?');
    expect(req.confirmLabel).toBe("Archive");
    expect(req.dontAskAgain).toBe(true);
    expect(req.checkbox).toMatchObject({ branchName: "show-approvers" });
    expect(h.taskArchive).toHaveBeenCalledWith("w1", true);
  });

  it("does nothing when the user cancels", async () => {
    h.askConfirm.mockResolvedValue({ confirmed: false, checked: true, dontAskAgain: false });
    await confirmAndArchive(task());
    expect(h.taskArchive).not.toHaveBeenCalled();
    expect(h.loadAll).not.toHaveBeenCalled();
  });

  it("remembers the opt-out AND the branch answer when both are ticked", async () => {
    h.askConfirm.mockResolvedValue({ confirmed: true, checked: true, dontAskAgain: true });
    await confirmAndArchive(task());
    expect(h.setConfirmBeforeArchiveTask).toHaveBeenCalledWith(false);
    expect(h.setArchiveDeleteBranch).toHaveBeenCalledWith(true);
  });

  it("does NOT remember anything when the user backs out with the box ticked", async () => {
    // ConfirmDialog reports the checkbox state at dismissal, so a cancelled
    // archive still arrives as dontAskAgain=true. Persisting it there would
    // silently disable every future confirmation.
    h.askConfirm.mockResolvedValue({ confirmed: false, checked: true, dontAskAgain: true });
    await confirmAndArchive(task());
    expect(h.setConfirmBeforeArchiveTask).not.toHaveBeenCalled();
    expect(h.setArchiveDeleteBranch).not.toHaveBeenCalled();
    expect(h.taskArchive).not.toHaveBeenCalled();
  });

  it("leaves the remembered branch answer alone for a main checkout", async () => {
    // That dialog shows no branch checkbox, so its `checked` is a meaningless
    // false and must not overwrite a stored "delete the branch".
    h.askConfirm.mockResolvedValue({ confirmed: true, checked: false, dontAskAgain: true });
    await confirmAndArchive(task({ is_main_checkout: true }));
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.confirmLabel).toBe("Remove entry");
    expect(req.checkbox).toBeUndefined();
    expect(h.setConfirmBeforeArchiveTask).toHaveBeenCalledWith(false);
    expect(h.setArchiveDeleteBranch).not.toHaveBeenCalled();
  });

  it("skips the dialog once the opt-out is stored, keeping the branch", async () => {
    h.prefs.confirmBeforeArchiveTask = false;
    await confirmAndArchive(task());
    expect(h.askConfirm).not.toHaveBeenCalled();
    expect(h.taskArchive).toHaveBeenCalledWith("w1", false);
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });

  it("silently deletes the branch when that was the remembered answer", async () => {
    h.prefs.confirmBeforeArchiveTask = false;
    h.prefs.archiveDeleteBranch = true;
    await confirmAndArchive(task());
    expect(h.taskArchive).toHaveBeenCalledWith("w1", true);
  });

  it("never applies the remembered branch delete to a main checkout", async () => {
    h.prefs.confirmBeforeArchiveTask = false;
    h.prefs.archiveDeleteBranch = true;
    await confirmAndArchive(task({ is_main_checkout: true }));
    expect(h.taskArchive).toHaveBeenCalledWith("w1", false);
  });

  it("clears the busy overlay even when the archive IPC rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.taskArchive.mockRejectedValue(new Error("worktree remove: locked"));
    await confirmAndArchive(task());
    expect(h.setBusy).toHaveBeenLastCalledWith(null);
    spy.mockRestore();
  });

  it("offers the plural branch checkbox for a multi-repo task", async () => {
    await confirmAndArchive(task({
      composition: [
        { mode: "worktree", dir_name: "api" },
        { mode: "worktree", dir_name: "web" },
      ] as Task["composition"],
    }));
    const req = h.askConfirm.mock.calls[0][0];
    expect(req.checkbox.label).toBe("Delete the git branches");
    expect(req.message).toContain("api, web");
    expect(req.dontAskAgain).toBe(true);
  });
});
