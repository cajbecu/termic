// Archive-a-task flow, shared by the sidebar row menu and the unified
// bar button so the post-archive state refresh can't drift between them.
//
// Issue #24: the sidebar didn't update after archiving until an app reload.
// Cause: `task_archive` marks the task `archived` and SAVES it
// before its best-effort cleanup (git worktree remove / rmdir / branch -D /
// symlink unlink). Any of those steps failing makes the command reject —
// even though the archive itself already happened. The call sites awaited it
// inside a try/catch and let that rejection skip the `loadAll()` refetch, so
// the now-archived task lingered in the sidebar until the next reload.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { taskArchive } from "@/lib/ipc";
import type { ConfirmCheckbox } from "@/store/ui";
import type { Task } from "@/lib/types";

/** Archive `taskId`, then ALWAYS refresh the store — even if the IPC rejects on
 *  a best-effort cleanup error, because the task is already persisted as
 *  archived and the sidebar must reflect that immediately (issue #24). The
 *  caller owns the confirm dialog + busy overlay. */
export async function archiveAndRefresh(taskId: string, deleteBranch: boolean): Promise<void> {
  try {
    await taskArchive(taskId, deleteBranch);
  } catch (err) {
    // Cleanup warning (the archive flag is still persisted). Surface it for
    // debugging but don't let it strand the sidebar.
    console.error("archive cleanup reported errors:", err);
  }
  // The archived task's view is going away — deselect it if it was active
  // so the main pane falls back to the dashboard.
  if (useApp.getState().activeTaskId === taskId) {
    useApp.getState().setActiveTask(null);
  }
  await useApp.getState().loadAll();
}

/** The prompt copy for archiving `w`, split out so the three shapes an archive
 *  can take (main checkout, multi-repo composition, plain worktree) are
 *  readable side by side. Main-checkout entries get NO checkbox: nothing about
 *  them is a worktree branch, so there is no branch to offer deleting.
 *
 *  `deleteBranchDefault` is the Settings toggle. It seeds the checkbox rather
 *  than deciding anything: the dialog is still the answer for THIS archive, so
 *  a user who keeps branches by default can tick the box once without changing
 *  the setting, and one who deletes them by default does not have to re-tick it
 *  every time. */
function archivePrompt(w: Task, deleteBranchDefault: boolean): { message: string; confirmLabel: string; checkbox?: ConfirmCheckbox } {
  if (w.is_main_checkout) {
    return {
      message: "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched, so you can re-open it any time. Any agent running here will be terminated.",
      confirmLabel: "Remove entry",
    };
  }
  if ((w.composition?.length ?? 0) > 0) {
    const members = (w.composition ?? []).filter(m => m.mode === "worktree").map(m => m.dir_name);
    return {
      message: `Branches stay in git, so you can recreate the task later. This removes: the host worktree + every member worktree (${members.join(", ") || "none"}), plus any member symlinks to live checkouts (those live repos are NOT touched). Any running agent will be terminated.`,
      confirmLabel: "Archive",
      checkbox: { label: "Delete the git branches", defaultValue: deleteBranchDefault },
    };
  }
  return {
    message: "The branch stays in git, so you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory (build artifacts: node_modules, .venv, untracked files) and terminates any running agent. Can't be undone from inside Termic.",
    confirmLabel: "Archive",
    checkbox: { label: "Delete the git branch:", branchName: w.branch || undefined, defaultValue: deleteBranchDefault },
  };
}

/** Confirm + archive a task, with the busy overlay. The ONLY archive entry
 *  point in the UI (sidebar row menu, unified bar button, command palette) so
 *  the copy, the delete-branch checkbox and the "Don't ask again" opt-out
 *  can't drift between them. No-op if the user cancels. */
export async function confirmAndArchive(w: Task): Promise<void> {
  const ui = useUI.getState();
  const prefs = usePrefs.getState();
  const { message, confirmLabel, checkbox } = archivePrompt(w, prefs.archiveDeleteBranch);

  // Fast path: confirmation is off, so the Settings toggle IS the answer -
  // never for a main checkout, which has no worktree branch and never showed
  // the checkbox.
  if (!prefs.confirmBeforeArchiveTask) {
    await runArchive(w, !w.is_main_checkout && prefs.archiveDeleteBranch);
    return;
  }

  const ok = await ui.askConfirm({
    title: `Archive "${w.name}"?`,
    message,
    confirmLabel,
    destructive: true,
    checkbox,
    dontAskAgain: true,
  });
  const res = typeof ok === "boolean" ? { confirmed: ok, checked: false, dontAskAgain: false } : ok;
  // Persist the opt-out only when the user actually went through with the
  // archive. ConfirmDialog reports the checkbox state at dismissal, so ticking
  // a box and then hitting Escape / Cancel still arrives as checked=true;
  // gating on `confirmed` stops a backed-out archive from silently disabling
  // every future confirmation (and arming a branch delete with it).
  if (res.confirmed && res.dontAskAgain) {
    prefs.setConfirmBeforeArchiveTask(false);
    // A main-checkout dialog has no checkbox, so its `checked` is a
    // meaningless false - leave the remembered branch choice alone.
    if (!w.is_main_checkout) prefs.setArchiveDeleteBranch(res.checked);
  }
  if (!res.confirmed) return;
  await runArchive(w, res.checked);
}

/** Busy overlay + archive. Split out so the confirmed and the "don't ask
 *  again" paths can't diverge on the overlay or the refresh. */
async function runArchive(w: Task, deleteBranch: boolean): Promise<void> {
  const ui = useUI.getState();
  ui.setBusy(`Archiving "${w.name}"…`);
  try { await archiveAndRefresh(w.id, deleteBranch); }
  finally { ui.setBusy(null); }
}
