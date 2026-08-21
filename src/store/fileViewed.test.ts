// "Mark as viewed" persistence (GH #42) and, mostly, what is allowed to CLEAR
// a mark (GH #248).
//
// Only two things may: the file's own fingerprint moving, and its task dying.
// The map is one namespace shared by the Git panel (uncommitted files only),
// the Compare panel (a whole branch diff) and DiffPane's compare walk, so any
// prune driven by one of those partial views destroys the others' live marks.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFileViewed } from "./fileViewed";

const TASK = "t1";
const OTHER = "t2";

// Map-backed stub: Node's own experimental `localStorage` global is unusable
// without `--localstorage-file` (same reasoning as prefs.test.ts and
// race.integration.test.ts). The store's module-level load() runs before this
// with no global at all, which its try/catch already treats as empty.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  useFileViewed.setState({ byTask: {} });
});

/** Same predicate as the useIsViewed hook, without a React renderer. */
const isViewed = (taskId: string, path: string, fp: string) =>
  useFileViewed.getState().byTask[taskId]?.[path] === fp && fp !== "";

describe("toggle", () => {
  it("marks a file at the fingerprint it was reviewed at", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    expect(isViewed(TASK, "src/a.ts", "111:20")).toBe(true);
  });

  it("unticks only when the same fingerprint is toggled again", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    expect(isViewed(TASK, "src/a.ts", "111:20")).toBe(false);
  });

  it("re-marks at the new fingerprint when the file moved under the tick", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    // Ticking a row whose fp has since moved stashes the NEW fp rather than
    // clearing, so the mark describes what the user actually just looked at.
    useFileViewed.getState().toggle(TASK, "src/a.ts", "222:30");
    expect(isViewed(TASK, "src/a.ts", "222:30")).toBe(true);
    expect(isViewed(TASK, "src/a.ts", "111:20")).toBe(false);
  });

  it("expires the mark once the agent edits the file", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    // Same path, fresh fingerprint from the next git-status poll.
    expect(isViewed(TASK, "src/a.ts", "999:40")).toBe(false);
  });

  it("never counts a deletion (empty fp) as viewed", () => {
    useFileViewed.getState().toggle(TASK, "src/gone.ts", "");
    expect(isViewed(TASK, "src/gone.ts", "")).toBe(false);
  });

  it("keeps tasks independent", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    expect(isViewed(OTHER, "src/a.ts", "111:20")).toBe(false);
  });

  it("survives a reload", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    expect(JSON.parse(localStorage.getItem("fileViewed") || "{}")).toEqual({
      [TASK]: { "src/a.ts": "111:20" },
    });
  });
});

describe("prune", () => {
  it("drops the map of a task that no longer exists", () => {
    useFileViewed.getState().toggle(OTHER, "src/a.ts", "111:20");
    useFileViewed.getState().prune(new Set([TASK]));
    expect(useFileViewed.getState().byTask[OTHER]).toBeUndefined();
  });

  it("keeps every path of a live task, whatever git status says", () => {
    // GH #248: `committed.ts` is in the branch compare but NOT in the
    // uncommitted list, which is exactly the file the old path-based prune
    // deleted. Task liveness is the only thing prune is allowed to consult.
    useFileViewed.getState().toggle(TASK, "uncommitted.ts", "111:20");
    useFileViewed.getState().toggle(TASK, "committed.ts", "222:30");
    useFileViewed.getState().prune(new Set([TASK]));
    expect(isViewed(TASK, "uncommitted.ts", "111:20")).toBe(true);
    expect(isViewed(TASK, "committed.ts", "222:30")).toBe(true);
  });

  it("survives the agent committing everything, leaving no changed files", () => {
    // The reported trigger: after the commit the Git panel's list is empty.
    // Nothing about an empty working tree may touch the stored marks.
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    useFileViewed.getState().toggle(TASK, "docs/hero.png", "222:30");
    useFileViewed.getState().prune(new Set([TASK]));
    expect(isViewed(TASK, "src/a.ts", "111:20")).toBe(true);
    expect(isViewed(TASK, "docs/hero.png", "222:30")).toBe(true);
  });

  it("writes through to localStorage when it does drop a task", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    useFileViewed.getState().toggle(OTHER, "src/b.ts", "222:30");
    useFileViewed.getState().prune(new Set([TASK]));
    expect(JSON.parse(localStorage.getItem("fileViewed") || "{}")).toEqual({
      [TASK]: { "src/a.ts": "111:20" },
    });
  });

  it("is a no-op when every task is still live", () => {
    useFileViewed.getState().toggle(TASK, "src/a.ts", "111:20");
    const before = useFileViewed.getState().byTask;
    useFileViewed.getState().prune(new Set([TASK]));
    // Same object identity: a no-op prune must not churn subscribers on
    // every loadAll (see performance.md bear trap 8).
    expect(useFileViewed.getState().byTask).toBe(before);
  });
});
