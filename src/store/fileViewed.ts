// "Mark as viewed" state for the Git panel's changed-file rows (GH issue
// #42). GitHub-style: each changed file gets a checkbox you tick once you've
// finished reviewing it, so attention naturally falls on the files you
// haven't looked at yet.
//
// Persisted to localStorage (survives restarts, unlike the transient
// review-comments store) and keyed by task, then by the
// task-relative file path (the same prefixed path a diff tab uses, so
// it's unique across multi-repo members).
//
// The stored value is the file's content fingerprint (GitFile.fp,
// `mtime:len`) at the moment it was marked. A file counts as "viewed" only
// when its CURRENT fingerprint still equals the stored one — so the instant
// the agent touches the file again, the fingerprint moves and the mark
// clears itself. No watcher needed: every git-status refetch carries a fresh
// fp, so isViewed() re-evaluates on its own.
//
// That per-file expiry is the ONLY thing allowed to clear a mark implicitly.
// Entries are removed wholesale only when their task dies (see prune).

import { create } from "zustand";

const LS = "fileViewed";

/** taskId → (task-relative path → fingerprint when marked viewed). */
type ByTask = Record<string, Record<string, string>>;

function load(): ByTask {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function save(byTask: ByTask) {
  try {
    localStorage.setItem(LS, JSON.stringify(byTask));
  } catch {}
}

interface FileViewedState {
  byTask: ByTask;
  /** Tick / untick a file. Ticking stashes its current fingerprint. */
  toggle: (taskId: string, path: string, fp: string) => void;
  /** Drop whole task maps for tasks that no longer exist (archived /
   *  deleted), keeping localStorage from growing without bound. Called from
   *  app.loadAll with the live task ids, mirroring useRace.prune.
   *
   *  Deliberately task-scoped and NOT path-scoped (GH #248). This map is one
   *  namespace shared by three call sites that each see a DIFFERENT slice of
   *  it: the Git panel lists uncommitted files, the Compare panel lists a
   *  whole branch diff, and DiffPane's compare walk reads marks for files
   *  that `git status` never returns. Pruning against any one of those slices
   *  deletes the others' live marks. That is exactly what used to happen: the
   *  Git panel pruned against its uncommitted list, so the moment an agent
   *  COMMITTED its work that list emptied and every Compare mark for the task
   *  went with it, including files the agent never touched. */
  prune: (liveTaskIds: Set<string>) => void;
}

export const useFileViewed = create<FileViewedState>((set) => ({
  byTask: load(),

  toggle: (taskId, path, fp) =>
    set((s) => {
      const cur = { ...(s.byTask[taskId] ?? {}) };
      if (cur[path] === fp) delete cur[path];
      else cur[path] = fp;
      const byTask = { ...s.byTask, [taskId]: cur };
      save(byTask);
      return { byTask };
    }),

  prune: (liveTaskIds) =>
    set((s) => {
      const dead = Object.keys(s.byTask).filter((id) => !liveTaskIds.has(id));
      if (dead.length === 0) return s;
      const byTask = { ...s.byTask };
      for (const id of dead) delete byTask[id];
      save(byTask);
      return { byTask };
    }),
}));

/** Subscribe to whether a specific file is currently marked viewed. A file
 *  is viewed only when its stashed fingerprint still matches `fp`, so an
 *  agent edit (fp moves) auto-clears the mark. */
export function useIsViewed(taskId: string, path: string, fp: string): boolean {
  return useFileViewed((s) => s.byTask[taskId]?.[path] === fp && fp !== "");
}
