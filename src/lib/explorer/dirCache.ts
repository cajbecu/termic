// Children-cache bookkeeping for the sidebar file tree (GH #159).
//
// The tree keeps one map of rel-path -> listing and one set of expanded
// rel-paths. The invariant that matters: every expanded directory either has
// a cached listing, has a read in flight, or is marked failed. Break it and
// the row renders "Loading…" forever with nothing left to fill it, which is
// exactly the bug #159 describes.
//
// These live outside the component so the invariant is unit-testable: there is
// no repro for #159, so the fix has to be argued from the state machine.

import type { FileEntry } from "@/lib/types";

/** The root listing's key in the children map. */
export const ROOT = "";

// Compare a freshly re-fetched listing against the cached one. `next` holds
// only the dirs we re-read (root + expanded), which are exactly the ones the
// tree renders, so it's the source of truth for keys: if every dir in `next`
// matches what we already have (same names, same dir-ness, same order from a
// stable readdir), the visible tree is unchanged and we can skip the update.
export function sameChildren(
  prev: Record<string, FileEntry[]>,
  next: Record<string, FileEntry[]>,
): boolean {
  for (const rel in next) {
    const a = prev[rel];
    const b = next[rel];
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) {
      if (a[i].name !== b[i].name || a[i].is_dir !== b[i].is_dir) return false;
    }
  }
  return true;
}

/** Fold a reload's results into the existing cache.
 *
 *  `fresh` holds only the dirs whose read SUCCEEDED. A wholesale replace was
 *  the root cause of #159: a directory being rewritten on disk (a build output
 *  dir getting removed and recreated) fails its read, drops out of the result
 *  map, and takes its cached listing with it while staying expanded.
 *
 *  - a failed dir keeps whatever listing it had (stale beats blank),
 *  - a dir expanded WHILE the reload was in flight keeps its listing too, as
 *    long as it is in `keep` when the reload lands,
 *  - a dir collapsed since the reload started is pruned,
 *  - the root is never pruned.
 */
export function mergeReload(
  prev: Record<string, FileEntry[]>,
  fresh: Record<string, FileEntry[]>,
  keep: Set<string>,
): Record<string, FileEntry[]> {
  const out: Record<string, FileEntry[]> = {};
  for (const rel in prev) {
    if (rel === ROOT || keep.has(rel)) out[rel] = prev[rel];
  }
  for (const rel in fresh) out[rel] = fresh[rel];
  return out;
}

/** Expanded dirs that violate the invariant: no listing, no read in flight,
 *  not already marked failed. The reconcile effect loads exactly these, which
 *  heals a dropped listing whatever dropped it. */
export function dirsNeedingLoad(
  expanded: Set<string>,
  children: Record<string, FileEntry[]>,
  loading: Set<string>,
  failed: Set<string>,
): string[] {
  const out: string[] = [];
  for (const rel of expanded) {
    if (children[rel] || loading.has(rel) || failed.has(rel)) continue;
    out.push(rel);
  }
  return out;
}

/** Drop `rel` from a set, returning the same set when it wasn't there.
 *  Keeping the reference lets the caller skip a setState (and the tree-wide
 *  re-render behind it) on the common no-op path. */
export function without(set: Set<string>, rel: string): Set<string> {
  if (!set.has(rel)) return set;
  const n = new Set(set);
  n.delete(rel);
  return n;
}
