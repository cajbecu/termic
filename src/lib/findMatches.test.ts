import { describe, it, expect } from "vitest";
import { findRanges, hitRanges } from "./findMatches";
import type { GrepHit } from "./ipc";

const LITERAL = { regex: false, case_sensitive: false };
const RE = { regex: true, case_sensitive: false };

const spans = (text: string, query: string, opts: typeof LITERAL) =>
  findRanges(text, query, opts).map(([a, b]) => text.slice(a, b));

describe("findRanges: literal mode", () => {
  it("finds every occurrence, case-insensitively", () => {
    expect(findRanges("Foo foo FOO", "foo", LITERAL)).toEqual([[0, 3], [4, 7], [8, 11]]);
  });

  it("treats regex metacharacters as text", () => {
    expect(spans("a.c abc", ".", LITERAL)).toEqual(["."]);
    expect(spans("f(x) fx", "f(x)", LITERAL)).toEqual(["f(x)"]);
    expect(findRanges("aaa", "a*", LITERAL)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(findRanges("abc", "", LITERAL)).toEqual([]);
  });
});

describe("findRanges: regex mode", () => {
  it("applies the pattern, case-insensitively", () => {
    expect(spans("useApp useUI", "use.pp", RE)).toEqual(["useApp"]);
    expect(spans("FOO bar", "f.o", RE)).toEqual(["FOO"]);
  });

  it("supports anchors, alternation and character classes", () => {
    expect(findRanges("foo foo", "^foo", RE)).toEqual([[0, 3]]);
    expect(spans("cat dog", "cat|dog", RE)).toEqual(["cat", "dog"]);
    expect(spans("a1b22", "[0-9]+", RE)).toEqual(["1", "22"]);
  });

  it("terminates on a pattern that matches an empty string", () => {
    expect(spans("aab", "a*", RE)).toEqual(["aa"]);
  });

  it("returns nothing for an unfinished pattern instead of throwing", () => {
    expect(findRanges("foo(bar)", "foo(", RE)).toEqual([]);
  });

  // The row itself came from git's POSIX ERE. ECMAScript does not share that
  // syntax, so these degrade to an unhighlighted line, never to a throw.
  it("degrades to no highlight for POSIX-only syntax", () => {
    expect(findRanges("abc 123", "[[:digit:]]+", RE)).toEqual([]);
    expect(findRanges("abc 123", "\\<abc\\>", RE)).toEqual([]);
  });
});

describe("findRanges: case_sensitive", () => {
  it("matches only the exact case in literal mode", () => {
    expect(spans("Foo foo FOO", "foo", { regex: false, case_sensitive: true })).toEqual(["foo"]);
    expect(findRanges("Foo FOO", "foo", { regex: false, case_sensitive: true })).toEqual([]);
  });

  it("matches only the exact case in regex mode", () => {
    expect(spans("Task task", "t.sk", { regex: true, case_sensitive: true })).toEqual(["task"]);
    expect(spans("Ab aB ab", "[ab]b", { regex: true, case_sensitive: true })).toEqual(["ab"]);
  });
});

// GH #181: ripgrep reports the offsets it actually matched, git grep can't.
// hitRanges is the seam, so it must prefer the backend's answer whenever
// there is one and only fall back to re-matching in JS.
describe("hitRanges: backend ranges vs re-matching", () => {
  const hit = (over: Partial<GrepHit>): GrepHit =>
    ({ path: "a.ts", line: 1, col: 1, preview: "foo bar foo", ranges: [], ...over });

  it("forwards the ranges ripgrep reported", () => {
    const h = hit({ ranges: [[0, 3], [8, 11]] });
    expect(hitRanges(h, "foo", LITERAL)).toEqual([[0, 3], [8, 11]]);
  });

  it("trusts those ranges even where JS would disagree", () => {
    // Rust regex matched something ECMAScript can't express the same way.
    // Painting the engine's answer beats painting our own re-derivation.
    const h = hit({ preview: "abc 123", ranges: [[4, 7]] });
    expect(hitRanges(h, "[[:digit:]]+", RE)).toEqual([[4, 7]]);
    expect(findRanges("abc 123", "[[:digit:]]+", RE)).toEqual([]);
  });

  it("re-matches the preview when the backend sent nothing", () => {
    expect(hitRanges(hit({}), "foo", LITERAL)).toEqual([[0, 3], [8, 11]]);
  });

  it("survives a hit with no ranges field at all", () => {
    // Defensive: an older payload shape must not throw during render.
    const legacy = { path: "a.ts", line: 1, col: 1, preview: "foo" } as GrepHit;
    expect(hitRanges(legacy, "foo", LITERAL)).toEqual([[0, 3]]);
  });

  it("highlights nothing when neither source has a match", () => {
    expect(hitRanges(hit({ preview: "nothing here" }), "zzz", LITERAL)).toEqual([]);
  });
});
