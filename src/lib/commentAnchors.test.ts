import { describe, it, expect } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
  anchorForLines, anchorStateChanged, linesForAnchor, mapAnchor, quoteForAnchor, stateForAnchor,
} from "./commentAnchors";

const doc = (...lines: string[]) => Text.of(lines);
const DOC = doc("one", "two", "three", "four", "five");

/** Apply `spec` to `d` and carry `a` across it, the way an edit in the editor
 *  moves a queued comment. */
const edit = (d: Text, a: { from: number; to: number }, spec: Parameters<typeof ChangeSet.of>[0]) => {
  const changes = ChangeSet.of(spec, d.length);
  return { doc: changes.apply(d), anchor: mapAnchor(a, changes) };
};

describe("anchorForLines", () => {
  it("covers whole lines, start to end", () => {
    const a = anchorForLines(DOC, 2, 3);
    expect(DOC.sliceString(a.from, a.to)).toBe("two\nthree");
  });

  it("clamps a range that runs past the end of the doc", () => {
    const a = anchorForLines(DOC, 4, 99);
    expect(linesForAnchor(DOC, a)).toEqual({ startLine: 4, endLine: 5 });
  });

  it("normalizes a reversed or below-1 range", () => {
    expect(linesForAnchor(DOC, anchorForLines(DOC, 0, 2))).toEqual({ startLine: 1, endLine: 2 });
    expect(linesForAnchor(DOC, anchorForLines(DOC, 3, 1))).toEqual({ startLine: 3, endLine: 3 });
  });
});

// The whole point of anchoring: a comment must keep pointing at ITS code, not
// at the line number that code happened to occupy when the comment was made.
describe("mapAnchor", () => {
  it("follows the code down when lines are inserted above", () => {
    const a = anchorForLines(DOC, 3, 3);                       // "three"
    const r = edit(DOC, a, { from: 0, insert: "zero\nhalf\n" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 5, endLine: 5 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("three");
  });

  // The regression that made this module necessary: an insert lands at exactly
  // the anchor's start offset, which is both "the end of what is above" and
  // "the start of the comment". It has to read as the former.
  it("slides down instead of swallowing text inserted at its exact start", () => {
    const a = anchorForLines(DOC, 1, 1);                       // "one", from === 0
    const r = edit(DOC, a, { from: 0, insert: "new A\nnew B\n" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 3, endLine: 3 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("one");
  });

  it("does not swallow a line appended right after its end", () => {
    const a = anchorForLines(DOC, 2, 3);
    const r = edit(DOC, a, { from: DOC.line(3).to, insert: "\nafter" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 2, endLine: 3 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("two\nthree");
  });

  it("stays put when the edit is below it", () => {
    const a = anchorForLines(DOC, 2, 2);
    const r = edit(DOC, a, { from: DOC.length, insert: "\nsix" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("moves up when lines above it are deleted", () => {
    const a = anchorForLines(DOC, 4, 5);
    const r = edit(DOC, a, { from: 0, to: DOC.line(2).from });  // drop line 1
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 3, endLine: 4 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("four\nfive");
  });

  it("grows to include text typed inside the range", () => {
    const a = anchorForLines(DOC, 2, 3);
    const r = edit(DOC, a, { from: DOC.line(2).to, insert: "\nextra" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 2, endLine: 4 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("two\nextra\nthree");
  });

  it("tracks a rewrite of the commented text itself", () => {
    const a = anchorForLines(DOC, 3, 3);
    const r = edit(DOC, a, { from: DOC.line(3).from, to: DOC.line(3).to, insert: "THREE!" });
    expect(linesForAnchor(r.doc, r.anchor)).toEqual({ startLine: 3, endLine: 3 });
    expect(quoteForAnchor(r.doc, r.anchor)).toBe("THREE!");
  });

  it("collapses onto the join line when the range is deleted outright", () => {
    const a = anchorForLines(DOC, 2, 3);
    const r = edit(DOC, a, { from: DOC.line(2).from, to: DOC.line(3).to });
    // The comment survives, pointing at where its code used to be — the batch
    // still carries the user's words, which beats dropping them silently.
    const st = stateForAnchor(r.doc, r.anchor);
    expect(st.startLine).toBe(2);
    expect(st.endLine).toBe(2);
  });

  it("survives a chain of edits, not just one", () => {
    let d = DOC;
    let a = anchorForLines(d, 3, 3);
    for (const insert of ["a\n", "b\n", "c\n"]) {
      const r = edit(d, a, { from: 0, insert });
      d = r.doc; a = r.anchor;
    }
    expect(linesForAnchor(d, a)).toEqual({ startLine: 6, endLine: 6 });
    expect(quoteForAnchor(d, a)).toBe("three");
  });
});

describe("anchorStateChanged", () => {
  const stored = { startLine: 3, endLine: 3, quote: "three" };

  it("is false when nothing moved (so the store is left alone)", () => {
    expect(anchorStateChanged(stored, { startLine: 3, endLine: 3, quote: "three" })).toBe(false);
  });

  it("is true when the lines shift", () => {
    expect(anchorStateChanged(stored, { startLine: 5, endLine: 5, quote: "three" })).toBe(true);
  });

  it("is true when only the quoted text changed", () => {
    expect(anchorStateChanged(stored, { startLine: 3, endLine: 3, quote: "THREE!" })).toBe(true);
  });

  it("treats a file-level comment (null lines) as changed", () => {
    expect(anchorStateChanged({ startLine: null, endLine: null, quote: "" },
      { startLine: 1, endLine: 1, quote: "one" })).toBe(true);
  });
});
