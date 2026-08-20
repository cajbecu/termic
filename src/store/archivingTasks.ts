// Tasks whose archive is running in the background (GH #246). The mirror of
// pendingTasks.ts at the other end of a task's life: there a task exists in
// the UI before it exists on disk, here it still exists on disk (worktree
// being torn down, archive script running) after the UI has moved on.
//
// Lives outside the app store on purpose. `useApp` is ~233 keys wide and
// every mounted task re-runs its selectors on any write, so a transient flag
// that flips twice per archive has no business in there (docs/performance.md
// bear trap 8). Same reasoning as pendingTasks.ts / scriptRuns.ts.
//
// Entries are removed when the archive settles, success or failure: unlike a
// pending create there's nothing to keep around afterwards, because the task
// itself is gone from the sidebar by then (loadAll dropped it) or, on a
// cleanup error, is still archived and equally gone. Failures surface as a
// toast, not as a lingering row.

import { create } from "zustand";

interface Store {
  /** Task ids with an archive in flight. */
  ids: Record<string, true>;
  begin: (id: string) => void;
  end: (id: string) => void;
}

export const useArchivingTasks = create<Store>((set) => ({
  ids: {},
  begin: (id) => set(s => (s.ids[id] ? s : { ids: { ...s.ids, [id]: true } })),
  end: (id) => set(s => {
    if (!s.ids[id]) return s;
    const { [id]: _, ...rest } = s.ids;
    return { ids: rest };
  }),
}));

/** True while `id`'s archive is in flight. Per-row selector so one archive
 *  re-renders one sidebar row, not the whole project section. */
export const useIsArchiving = (id: string) => useArchivingTasks(s => !!s.ids[id]);

/** Non-reactive read, for the double-fire guard in the archive flow. */
export const isArchiving = (id: string) => !!useArchivingTasks.getState().ids[id];
