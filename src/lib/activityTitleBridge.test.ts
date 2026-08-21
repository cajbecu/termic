import { describe, it, expect } from "vitest";
import { sameTitles } from "@/lib/activityTitleBridge";

// The Activity window asks for titles on every sample tick, so nearly every
// reply is byte-identical to the last. `sameTitles` is what stops that from
// handing React a fresh object once a second and re-running `groupRows` for
// nothing (the cross-window twin of docs/performance.md bear trap 8), so its
// edges are worth pinning: a false "same" would freeze titles on screen.
describe("sameTitles", () => {
  it("treats an identical reply as unchanged", () => {
    expect(sameTitles({ a: "✳ ship", b: "Terminal" }, { a: "✳ ship", b: "Terminal" })).toBe(true);
    expect(sameTitles({}, {})).toBe(true);
  });

  it("is insensitive to key order", () => {
    // The main window builds the map by iterating a store object, so the
    // insertion order is not something the reply can promise.
    expect(sameTitles({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  });

  it("catches a changed title", () => {
    // The case that matters: an agent flipping from spinner to idle glyph.
    expect(sameTitles({ a: "⠋ ship" }, { a: "✳ ship" })).toBe(false);
  });

  it("catches a tab appearing or disappearing", () => {
    expect(sameTitles({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(sameTitles({ a: "1", b: "2" }, { a: "1" })).toBe(false);
  });

  it("catches a rename that swaps two tabs' titles", () => {
    // Same keys, same multiset of values, same size: only a per-key compare
    // sees this one.
    expect(sameTitles({ a: "one", b: "two" }, { a: "two", b: "one" })).toBe(false);
  });
});
