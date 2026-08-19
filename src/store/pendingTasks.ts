// A task being created: worktree/branch not ready yet, backed only by the
// client-generated uuid the New Task dialog mints before invoking
// task_create/task_create_multi. Lives outside the app store because it
// churns line-by-line while creating (would re-render unrelated app store
// subscribers otherwise) — same reasoning as scriptRuns.ts, same shape.
//
// Entries are NOT removed on success: once the real task lands in the app
// store's `tasks` array (via loadAll), MainArea and the sidebar prefer the
// real task over the pending entry (see selectPendingTask / TaskRow usage),
// so a lingering "done" entry is inert. `remove` is only ever called
// explicitly, when the user dismisses an error.

import { create } from "zustand";

export type PendingTaskPhase = "creating" | "error";

export interface PendingTask {
  id: string;
  projectId: string;
  name: string;
  cli: string;
  phase: PendingTaskPhase;
  log: string[];
  err: string | null;
}

const MAX_LINES = 2000;

interface Store {
  pending: Record<string, PendingTask>;
  add: (task: { id: string; projectId: string; name: string; cli: string }) => void;
  appendLine: (id: string, line: string) => void;
  fail: (id: string, err: string) => void;
  remove: (id: string) => void;
}

export const usePendingTasks = create<Store>((set) => ({
  pending: {},
  add: ({ id, projectId, name, cli }) => set(s => ({
    pending: { ...s.pending, [id]: { id, projectId, name, cli, phase: "creating", log: [], err: null } },
  })),
  appendLine: (id, line) => set(s => {
    const cur = s.pending[id];
    if (!cur) return s;
    const over = Math.max(0, cur.log.length + 1 - MAX_LINES);
    const next = cur.log.slice(over);
    next.push(line);
    return { pending: { ...s.pending, [id]: { ...cur, log: next } } };
  }),
  fail: (id, err) => set(s => {
    const cur = s.pending[id];
    if (!cur) return s;
    return { pending: { ...s.pending, [id]: { ...cur, phase: "error", err } } };
  }),
  remove: (id) => set(s => {
    if (!s.pending[id]) return s;
    const { [id]: _, ...rest } = s.pending;
    return { pending: rest };
  }),
}));

/** Tight selector for a single pending entry, undefined once it isn't (or
 *  never was) pending — used by MainArea/Sidebar to fall back to the real
 *  task the moment it shows up in the app store. */
export const usePendingTask = (id: string | null | undefined) =>
  usePendingTasks(s => (id ? s.pending[id] : undefined));
