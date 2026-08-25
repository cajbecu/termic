// How a task is named in the UI (GH #260).
//
// A task keeps whatever title was typed at creation. That is right for a task
// finished the same day, but one that sits for a week next to a dozen others
// is remembered by its branch: that is the name on the PR, in `git log` and in
// every conversation about the work. The `useBranchAsTaskName` pref (Settings
// -> Tasks, off by default) swaps the label for the branch wherever a task is
// named, and this is the single place that decides it.
//
// Worktree tasks only (see `identifyingBranch`). The branch read here is the
// one frozen on the task record at creation, the same value the breadcrumb has
// always shown. Checking out a different branch inside the worktree does not
// rewrite it, and resolving live HEAD instead would mean a git call per sidebar
// row on every render.

import { usePrefs } from "@/store/prefs";

/** The fields a label needs. Structural, so callers can pass a `Task`, an
 *  archived record, or anything else carrying a name and a branch. */
export interface TaskLike {
  name: string;
  branch?: string;
  is_main_checkout?: boolean;
}

/** A branch value that is not a branch name. `task_open_repo` re-reads HEAD
 *  every time a main-checkout task opens and records the literal "HEAD" when
 *  that checkout is detached. */
const DETACHED = "HEAD";

/** The branch this task is identified BY, or "" when it has none.
 *
 *  Worktree tasks only, deliberately. A main-checkout task ("Run in repo")
 *  does carry a branch, but it is whatever the shared checkout happens to be
 *  on: usually "main", so relabelling would give every project's repo-root row
 *  the same word, and it moves under the task whenever anyone runs `git
 *  checkout` there. A worktree's branch was cut FOR that task and is the name
 *  its PR and `git log` use, which is the whole premise of GH #260. */
function identifyingBranch(task: TaskLike): string {
  if (task.is_main_checkout) return "";
  return !task.branch || task.branch === DETACHED ? "" : task.branch;
}

/** What to show for `task` in the sidebar, breadcrumb, switchers and menus.
 *  Falls back to the typed name when the pref is off, and whenever the task
 *  has no branch to be identified by: plain-folder tasks store `""`, a
 *  detached checkout stores "HEAD", and a main checkout is excluded outright.
 *  That is the issue's "before the branch exists, nothing changes". */
export function taskLabel(task: TaskLike, useBranch: boolean): string {
  const branch = identifyingBranch(task);
  return useBranch && branch ? branch : task.name;
}

/** True when `task` is currently labelled by something other than its typed
 *  name, so a caller can surface the original (a row tooltip, a rename hint)
 *  rather than lose it. */
export function taskLabelIsBranch(task: TaskLike, useBranch: boolean): boolean {
  return taskLabel(task, useBranch) !== task.name;
}

/** Component-side sugar: subscribes to the one boolean, nothing else. */
export function useTaskLabel(task: TaskLike | null | undefined): string {
  const useBranch = usePrefs(s => s.useBranchAsTaskName);
  return task ? taskLabel(task, useBranch) : "";
}
