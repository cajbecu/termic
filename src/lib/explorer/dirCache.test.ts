import { describe, it, expect } from "vitest";
import type { FileEntry } from "@/lib/types";
import { ROOT, sameChildren, mergeReload, dirsNeedingLoad, without, withoutKey } from "./dirCache";

const dir = (name: string): FileEntry => ({ name, is_dir: true });
const file = (name: string): FileEntry => ({ name, is_dir: false });

describe("sameChildren", () => {
  it("is true when every re-fetched dir matches the cache", () => {
    const prev = { [ROOT]: [dir("src"), file("a.ts")], src: [file("b.ts")] };
    expect(sameChildren(prev, { [ROOT]: [dir("src"), file("a.ts")] })).toBe(true);
    expect(sameChildren(prev, { src: [file("b.ts")] })).toBe(true);
  });

  it("is false on a new name, a changed dir-ness, a different length or a missing key", () => {
    const prev = { src: [file("b.ts")] };
    expect(sameChildren(prev, { src: [file("c.ts")] })).toBe(false);
    expect(sameChildren(prev, { src: [dir("b.ts")] })).toBe(false);
    expect(sameChildren(prev, { src: [file("b.ts"), file("c.ts")] })).toBe(false);
    expect(sameChildren(prev, { docs: [file("d.md")] })).toBe(false);
  });

  it("ignores cached dirs that were not re-fetched", () => {
    // `next` only ever holds root + expanded dirs, which is all the tree renders.
    expect(sameChildren({ [ROOT]: [dir("src")], stale: [] }, { [ROOT]: [dir("src")] })).toBe(true);
  });
});

describe("mergeReload", () => {
  it("keeps the cached listing of a dir whose read failed (GH #159)", () => {
    // `build` was rewritten on disk mid-reload, so it is absent from `fresh`.
    const prev = { [ROOT]: [dir("build"), dir("src")], build: [file("app.js")], src: [file("a.ts")] };
    const fresh = { [ROOT]: [dir("build"), dir("src")], src: [file("a.ts"), file("b.ts")] };
    const out = mergeReload(prev, fresh, new Set(["build", "src"]));
    expect(out.build).toEqual([file("app.js")]);
    expect(out.src).toEqual([file("a.ts"), file("b.ts")]);
  });

  it("keeps a dir expanded while the reload was in flight", () => {
    // `docs` was expanded (and loaded) after the reload started, so it is in
    // neither `fresh` nor the reload's original dir list.
    const prev = { [ROOT]: [dir("docs")], docs: [file("d.md")] };
    const out = mergeReload(prev, { [ROOT]: [dir("docs")] }, new Set(["docs"]));
    expect(out.docs).toEqual([file("d.md")]);
  });

  it("prunes a dir collapsed since the reload started, but never the root", () => {
    const prev = { [ROOT]: [dir("src")], src: [file("a.ts")] };
    const out = mergeReload(prev, { [ROOT]: [dir("src")] }, new Set());
    expect(out).toEqual({ [ROOT]: [dir("src")] });
  });

  it("takes the fresh listing over the cached one", () => {
    const out = mergeReload({ src: [file("a.ts")] }, { src: [file("b.ts")] }, new Set(["src"]));
    expect(out.src).toEqual([file("b.ts")]);
  });

  it("adds a dir that was not cached at all", () => {
    const out = mergeReload({}, { [ROOT]: [dir("src")], src: [] }, new Set(["src"]));
    expect(out).toEqual({ [ROOT]: [dir("src")], src: [] });
  });
});

describe("dirsNeedingLoad", () => {
  const expanded = new Set(["src", "build", "docs", "gone"]);

  it("returns exactly the expanded dirs with no listing, no read in flight and no failure", () => {
    const children = { src: [file("a.ts")] };
    const out = dirsNeedingLoad(expanded, children, new Set(["docs"]), new Set(["gone"]));
    expect(out).toEqual(["build"]);
  });

  it("is empty once every expanded dir is accounted for", () => {
    const children = { src: [], build: [], docs: [], gone: [] };
    expect(dirsNeedingLoad(expanded, children, new Set(), new Set())).toEqual([]);
  });

  it("treats an empty listing as loaded, not missing", () => {
    // An empty dir caches `[]`, which is falsy-adjacent but must not re-load.
    expect(dirsNeedingLoad(new Set(["empty"]), { empty: [] }, new Set(), new Set())).toEqual([]);
  });

  it("ignores cached dirs that are no longer expanded", () => {
    expect(dirsNeedingLoad(new Set(), { src: [] }, new Set(), new Set())).toEqual([]);
  });
});

describe("without", () => {
  it("returns the same set when the key is absent, so callers can skip a setState", () => {
    const s = new Set(["a"]);
    expect(without(s, "b")).toBe(s);
  });

  it("returns a new set without the key", () => {
    const s = new Set(["a", "b"]);
    const out = without(s, "a");
    expect(out).not.toBe(s);
    expect([...out]).toEqual(["b"]);
    expect(s.has("a")).toBe(true);
  });
});

describe("withoutKey", () => {
  it("returns the same map when the key is absent", () => {
    const m = new Map([["a", "boom"]]);
    expect(withoutKey(m, "b")).toBe(m);
  });

  it("returns a new map without the key, leaving the original alone", () => {
    const m = new Map([["a", "boom"], ["b", "bang"]]);
    const out = withoutKey(m, "a");
    expect(out).not.toBe(m);
    expect([...out.keys()]).toEqual(["b"]);
    expect(m.has("a")).toBe(true);
  });
});

describe("dirsNeedingLoad with the failed map", () => {
  it("skips a dir that failed, whether failures are a set or a map", () => {
    const expanded = new Set(["src", "gone"]);
    const failed = new Map([["gone", "Permission denied (os error 13)"]]);
    expect(dirsNeedingLoad(expanded, {}, new Set(), failed)).toEqual(["src"]);
  });
});
