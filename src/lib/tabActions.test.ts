import { describe, it, expect } from "vitest";
import { pinBoundary, closableSiblings, type StripTab } from "./tabActions";

const strip = (...spec: string[]): StripTab[] =>
  spec.map(s => (s.endsWith("*") ? { id: s.slice(0, -1), pinned: true } : { id: s }));

describe("pinBoundary", () => {
  it("is 0 when nothing is pinned", () => {
    expect(pinBoundary(strip("a", "b", "c"), "c")).toBe(0);
  });

  it("counts the pinned block", () => {
    expect(pinBoundary(strip("a*", "b*", "c", "d"), "d")).toBe(2);
  });

  it("ignores the moving tab's own pinned flag", () => {
    // Unpinning "b" must land it right after "a", not after itself.
    expect(pinBoundary(strip("a*", "b*", "c"), "b")).toBe(1);
    // Pinning "c" appends it to the block, which is still 2 long without it.
    expect(pinBoundary(strip("a*", "b*", "c"), "c")).toBe(2);
  });

  it("is the whole length when every other tab is pinned", () => {
    expect(pinBoundary(strip("a*", "b*", "c"), "c")).toBe(2);
  });
});

describe("closableSiblings", () => {
  it("others: every unpinned tab but the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c"), "b", "others")).toEqual(["a", "c"]);
  });

  it("others: skips pinned tabs", () => {
    expect(closableSiblings(strip("a*", "b", "c", "d*"), "b", "others")).toEqual(["c"]);
  });

  it("right: only the tabs after the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c", "d"), "b", "right")).toEqual(["c", "d"]);
  });

  it("right: skips pinned tabs after the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c*", "d"), "b", "right")).toEqual(["d"]);
  });

  it("right: empty on the last tab", () => {
    expect(closableSiblings(strip("a", "b"), "b", "right")).toEqual([]);
  });

  it("others: empty when the clicked tab is the only unpinned one", () => {
    expect(closableSiblings(strip("a*", "b"), "b", "others")).toEqual([]);
  });

  it("never closes the clicked tab, even when it is pinned", () => {
    expect(closableSiblings(strip("a*", "b", "c"), "a", "others")).toEqual(["b", "c"]);
    expect(closableSiblings(strip("a*", "b", "c"), "a", "right")).toEqual(["b", "c"]);
  });

  it("is empty for an unknown tab id", () => {
    expect(closableSiblings(strip("a", "b"), "zz", "others")).toEqual([]);
    expect(closableSiblings(strip("a", "b"), "zz", "right")).toEqual([]);
  });
});
