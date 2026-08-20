import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  taskArchive: vi.fn(),
  loadAll: vi.fn(),
  setActiveTask: vi.fn(),
  askConfirm: vi.fn(),
  setBusy: vi.fn(),
  pushToast: vi.fn(),
  setView: vi.fn(),
  setConfirmBeforeArchiveTask: vi.fn(),
  setArchiveDeleteBranch: vi.fn(),
  state: { activeTaskId: null as string | null, tasks: [] as unknown[] },
  prefs: { confirmBeforeArchiveTask: true, archiveDeleteBranch: false },
}));

vi.mock("@/lib/ipc", () => ({ taskArchive: h.taskArchive }));
vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({
      activeTaskId: h.state.activeTaskId,
      tasks: h.state.tasks,
      setActiveTask: h.setActiveTask,
      loadAll: h.loadAll,
      setView: h.setView,
    }),
  },
}));
// The real ui/prefs stores touch `document` on import (theme application),
// which the node test environment has no answer for.
vi.mock("@/store/ui", () => ({
  useUI: { getState: () => ({ askConfirm: h.askConfirm, setBusy: h.setBusy, pushToast: h.pushToast }) },
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
import { useArchivingTasks } from "@/store/archivingTasks";
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
  h.pushToast.mockReset();
  h.setView.mockReset();
  h.setConfirmBeforeArchiveTask.mockReset();
  h.setArchiveDeleteBranch.mockReset();
  h.state.activeTaskId = null;
  h.state.tasks = [];
  h.prefs.confirmBeforeArchiveTask = true;
  h.prefs.archiveDeleteBranch = false;
  useArchivingTasks.setState({ ids: {} });
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
    // Archiving is recoverable (History + the branch in git), so the prompt
    // is not dressed as a one-way action (issue #102).
    expect(req.destructive).toBe(false);
    expect(req.message).toContain("History");
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

  it("toasts a way back to History when the confirmation is off", async () => {
    // The silent archive shows nothing else, so the toast is the only signal
    // that it happened AND the only pointer to where the task went.
    h.prefs.confirmBeforeArchiveTask = false;
    await confirmAndArchive(task());
    const [msg, kind, opts] = h.pushToast.mock.calls[0];
    expect(msg).toContain("show approvers");
    expect(msg).toContain("History");
    expect(kind).toBe("info");
    opts.action.onClick();
    expect(h.setView).toHaveBeenCalledWith("history");
  });

  it("does NOT toast when the user answered the dialog", async () => {
    // The dialog already told them what archiving does; a toast on top of it
    // is noise.
    await confirmAndArchive(task());
    expect(h.taskArchive).toHaveBeenCalled();
    expect(h.pushToast).not.toHaveBeenCalled();
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

  it("clears the archiving row state even when the archive IPC rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.taskArchive.mockRejectedValue(new Error("worktree remove: locked"));
    await confirmAndArchive(task());
    expect(useArchivingTasks.getState().ids).toEqual({});
    spy.mockRestore();
  });

  it("seeds the dialog checkbox from the Settings toggle", async () => {
    // The toggle is a default, not a decision: with confirmation ON the dialog
    // still answers for THIS archive, so someone who deletes branches every
    // time does not re-tick the box on every single archive.
    h.prefs.archiveDeleteBranch = true;
    await confirmAndArchive(task());
    expect(h.askConfirm.mock.calls[0][0].checkbox.defaultValue).toBe(true);
  });

  it("leaves the dialog checkbox unticked when the toggle is off", async () => {
    h.prefs.archiveDeleteBranch = false;
    await confirmAndArchive(task());
    expect(h.askConfirm.mock.calls[0][0].checkbox.defaultValue).toBe(false);
  });

  it("lets the dialog override the seeded default for one archive", async () => {
    // Seeded on, unticked in the dialog: this archive keeps the branch, and
    // the stored default is NOT rewritten, because "Show this every time"
    // stayed ticked.
    h.prefs.archiveDeleteBranch = true;
    h.askConfirm.mockResolvedValue({ confirmed: true, checked: false, dontAskAgain: false });
    await confirmAndArchive(task());
    expect(h.taskArchive).toHaveBeenCalledWith("w1", false);
    expect(h.setArchiveDeleteBranch).not.toHaveBeenCalled();
  });

  it("seeds the plural checkbox for a multi-repo task too", async () => {
    h.prefs.archiveDeleteBranch = true;
    await confirmAndArchive(task({
      composition: [{ mode: "worktree", dir_name: "api" }] as Task["composition"],
    }));
    expect(h.askConfirm.mock.calls[0][0].checkbox.defaultValue).toBe(true);
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

// GH #246: archiving used to raise the full-window busy overlay and hold it
// until task_archive + loadAll returned — an archive script, a `git worktree
// remove` and an rm -rf over node_modules, with every other task's agent
// unreachable behind a click-blocker. Now the work runs in the background and
// only the archived task's own row changes.
describe("non-blocking archive (GH #246)", () => {
  it("never raises the busy overlay", async () => {
    await confirmAndArchive(task());
    expect(h.setBusy).not.toHaveBeenCalled();
  });

  it("marks the task archiving before the IPC settles, and clears it after", async () => {
    let release: () => void;
    h.taskArchive.mockReturnValue(new Promise<void>(res => { release = () => res(); }));

    const done = confirmAndArchive(task());
    // Let askConfirm's promise resolve so runArchive has actually started.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(useArchivingTasks.getState().ids).toEqual({ w1: true });

    release!();
    await done;
    expect(useArchivingTasks.getState().ids).toEqual({});
  });

  it("deselects the active task immediately, not after the archive finishes", async () => {
    h.state.activeTaskId = "w1";
    let release: () => void;
    h.taskArchive.mockReturnValue(new Promise<void>(res => { release = () => res(); }));

    const done = confirmAndArchive(task());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // The task's pane is in front of the user with its worktree being removed
    // underneath it — it can't wait for the rmdir.
    expect(h.setActiveTask).toHaveBeenCalledWith(null);
    expect(h.loadAll).not.toHaveBeenCalled();

    release!();
    await done;
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });

  it("ignores a second archive of the same task while one is in flight", async () => {
    // Without the modal there is nothing stopping the row menu, the unified
    // bar button and the command palette from all firing.
    h.prefs.confirmBeforeArchiveTask = false;
    let release: () => void;
    h.taskArchive.mockReturnValue(new Promise<void>(res => { release = () => res(); }));

    const first = confirmAndArchive(task());
    await Promise.resolve(); await Promise.resolve();
    await confirmAndArchive(task());
    expect(h.taskArchive).toHaveBeenCalledTimes(1);

    release!();
    await first;
  });

  it("toasts a cleanup failure instead of letting the task vanish silently", async () => {
    // The overlay used to imply something happened. In the background there's
    // no other signal that a worktree is still sitting on disk.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.tasks = [{ id: "w1", name: "show approvers" }];
    h.taskArchive.mockRejectedValue(new Error("worktree remove: locked"));

    await confirmAndArchive(task());
    const errToast = h.pushToast.mock.calls.find(c => c[1] === "error");
    expect(errToast).toBeDefined();
    expect(errToast![0]).toContain("show approvers");
    expect(errToast![0]).toContain("worktree remove: locked");
    spy.mockRestore();
  });

  it("toasts the confirmation-off archive before the archive finishes", async () => {
    h.prefs.confirmBeforeArchiveTask = false;
    let release: () => void;
    h.taskArchive.mockReturnValue(new Promise<void>(res => { release = () => res(); }));

    const done = confirmAndArchive(task());
    await Promise.resolve(); await Promise.resolve();
    expect(h.pushToast).toHaveBeenCalledTimes(1);

    release!();
    await done;
  });
});
