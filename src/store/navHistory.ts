// Where you were before you followed that symbol (GH #174).
//
// Following a definition is a one-way trip without this, and reading
// unfamiliar code is mostly a sequence of one-way trips you need to come back
// from. Every IDE has it (IntelliJ ⌘[ / ⌘], VS Code ⌃- / ⌃⇧-), and it is the
// single feature whose absence makes navigation feel like a dead end.
//
// Deliberately app-level rather than per-editor: a jump can land in another
// file, another tab, or a read-only external tab outside the checkout, so
// "back" has to be able to reopen a tab, not just move a cursor.

import { create } from "zustand";

export interface NavPoint {
  taskId: string;
  /** Task-relative for a file in the checkout, absolute for an external one. */
  path: string;
  /** True when `path` is absolute and outside the task (GH #240's tab type). */
  external: boolean;
  line: number;
  col?: number;
}

/**
 * Two points are "the same place" when they are the same LINE of the same
 * file.
 *
 * An earlier version allowed a few lines of slack, to stop cursor nudges
 * becoming history entries. That was defending against something that cannot
 * happen — only explicit navigations reach `push`, never a cursor move — and
 * it cost real jumps: going to a definition three lines up recorded nothing,
 * so Back skipped past it to whatever came before. Exact is both simpler and
 * right.
 */
function samePlace(a: NavPoint, b: NavPoint): boolean {
  return a.taskId === b.taskId && a.path === b.path && a.line === b.line;
}

/** How many hops to remember. IntelliJ keeps far more, but a jump list is a
 *  breadcrumb trail, not an archive: past a few dozen you use a different tool
 *  to find the place again. */
const LIMIT = 50;

interface NavHistoryState {
  /** Oldest first. `index` points at where you are now. */
  stack: NavPoint[];
  index: number;
  /** Record a jump: `from` is where you left, `to` is where you landed. */
  push: (from: NavPoint | null, to: NavPoint) => void;
  back: () => NavPoint | null;
  forward: () => NavPoint | null;
  canBack: () => boolean;
  canForward: () => boolean;
  /** Drop everything for a task that no longer exists. */
  pruneTo: (liveTaskIds: string[]) => void;
  reset: () => void;
}

export const useNavHistory = create<NavHistoryState>((set, get) => ({
  stack: [],
  index: -1,

  push: (from, to) => {
    const { stack, index } = get();
    // Anything ahead of here is a branch you did not take: jumping somewhere
    // new from the middle of the history replaces the forward half, exactly
    // as a browser does.
    const trimmed = stack.slice(0, index + 1);
    // The departure point is only worth recording when it is not already the
    // top of the stack — otherwise a chain of jumps records each place twice.
    if (from && (!trimmed.length || !samePlace(trimmed[trimmed.length - 1], from))) {
      trimmed.push(from);
    }
    if (trimmed.length && samePlace(trimmed[trimmed.length - 1], to)) {
      // Landed where we already are: nothing to remember, but the index still
      // has to point at the end.
      set({ stack: trimmed, index: trimmed.length - 1 });
      return;
    }
    trimmed.push(to);
    const overflow = Math.max(0, trimmed.length - LIMIT);
    const stackNext = overflow ? trimmed.slice(overflow) : trimmed;
    set({ stack: stackNext, index: stackNext.length - 1 });
  },

  back: () => {
    const { stack, index } = get();
    if (index <= 0) return null;
    set({ index: index - 1 });
    return stack[index - 1];
  },

  forward: () => {
    const { stack, index } = get();
    if (index < 0 || index >= stack.length - 1) return null;
    set({ index: index + 1 });
    return stack[index + 1];
  },

  canBack: () => get().index > 0,
  canForward: () => {
    const { stack, index } = get();
    return index >= 0 && index < stack.length - 1;
  },

  pruneTo: (liveTaskIds) => {
    const live = new Set(liveTaskIds);
    const { stack, index } = get();
    const kept = stack.filter(p => live.has(p.taskId));
    if (kept.length === stack.length) return;   // no-op writes re-run selectors
    // Keep the cursor as close to where it was as the surviving trail allows.
    set({ stack: kept, index: Math.min(index, kept.length - 1) });
  },

  reset: () => {
    if (!get().stack.length && get().index === -1) return;
    set({ stack: [], index: -1 });
  },
}));
