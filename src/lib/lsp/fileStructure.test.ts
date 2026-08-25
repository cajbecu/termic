import { describe, it, expect } from "vitest";
import { flattenSymbols, filterOutline } from "./fileStructure";

// IntelliJ's ⌘F12. Servers still disagree about which shape they answer with —
// the flat SymbolInformation list or the DocumentSymbol tree — so both are
// flattened here rather than at each call site, where one of them would
// eventually be forgotten and a whole server would silently show nothing.

describe("whichever shape the server sent", () => {
  it("reads the tree shape, keeping the nesting", () => {
    const rows = flattenSymbols([
      {
        name: "StorePage", kind: 5,
        selectionRange: { start: { line: 500 } },
        children: [
          { name: "save", kind: 6, selectionRange: { start: { line: 520 } } },
          { name: "objects", kind: 8, selectionRange: { start: { line: 505 } } },
        ],
      },
    ]);
    expect(rows.map(r => [r.name, r.kind, r.line, r.depth])).toEqual([
      ["StorePage", "class", 501, 0],
      ["save", "method", 521, 1],
      ["objects", "field", 506, 1],
    ]);
    // A method knows which class it is in, which is what makes a FILTERED
    // list (where indentation is meaningless) still readable.
    expect(rows[1].parent).toBe("StorePage");
  });

  it("reads the flat shape, taking the container as the parent", () => {
    const rows = flattenSymbols([
      { name: "helper", kind: 12, location: { range: { start: { line: 9 } } }, containerName: "utils" },
    ]);
    expect(rows).toEqual([{ name: "helper", kind: "function", line: 10, depth: 0, parent: "utils" }]);
  });

  it("skips a symbol with no position rather than landing on line 1", () => {
    const rows = flattenSymbols([{ name: "nowhere", kind: 12 }]);
    expect(rows).toEqual([]);
  });

  it("has nothing to say about nothing", () => {
    expect(flattenSymbols(null)).toEqual([]);
    expect(flattenSymbols([])).toEqual([]);
  });
});

describe("filtering the outline", () => {
  const rows = flattenSymbols([
    { name: "StorePageSerializer", kind: 5, selectionRange: { start: { line: 10 } } },
    { name: "save", kind: 12, selectionRange: { start: { line: 20 } } },
    { name: "store_page", kind: 13, selectionRange: { start: { line: 30 } } },
  ]);

  it("puts a prefix match first, then a substring, then a subsequence", () => {
    // "s" matches all three; the ordering is what makes the first Enter right.
    expect(filterOutline(rows, "s").map(r => r.name)).toEqual(
      ["StorePageSerializer", "save", "store_page"]);
  });

  it("matches initials the way a symbol search should", () => {
    // "sps" finds StorePageSerializer without typing it out.
    expect(filterOutline(rows, "sps").map(r => r.name)).toEqual(["StorePageSerializer"]);
  });

  it("is case-insensitive and returns everything for an empty query", () => {
    expect(filterOutline(rows, "STORE").map(r => r.name)).toContain("StorePageSerializer");
    expect(filterOutline(rows, "  ")).toHaveLength(3);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterOutline(rows, "zzz")).toEqual([]);
  });
});
