import { describe, it, expect } from "vitest";
import {
  deriveScratchTitle, scratchFilenameSlug, SCRATCH_TITLE_MAX, SCRATCH_UNTITLED,
} from "./scratchTitle";

describe("deriveScratchTitle", () => {
  it("fills the title from as many lines as fit", () => {
    // A jotted note's first line is routinely one word, so a first-line-only
    // title would read "asd" for every pad the user has open.
    expect(deriveScratchTitle("asd\nas\nd\nasd asd")).toBe("asd as d asd asd");
    // Leading blank lines are skipped, not titled.
    expect(deriveScratchTitle("\n\n   \nreal line\n")).toBe("real line");
    // Blank lines between content collapse away entirely.
    expect(deriveScratchTitle("one\n\n\ntwo")).toBe("one two");
  });

  it("stops at the cap instead of reading the whole buffer", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = deriveScratchTitle(long);
    // The cap plus at most the ellipsis. Exactly MAX when the cut landed on a
    // space, which trimEnd removes rather than leaving before the ellipsis.
    expect(out.length).toBeLessThanOrEqual(SCRATCH_TITLE_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("line 0 line 1 line 2")).toBe(true);
  });

  it("falls back to Untitled for an empty or whitespace-only buffer", () => {
    expect(deriveScratchTitle("")).toBe(SCRATCH_UNTITLED);
    expect(deriveScratchTitle("\n \t\n")).toBe(SCRATCH_UNTITLED);
  });

  it("truncates past the max and marks it", () => {
    const long = "a".repeat(SCRATCH_TITLE_MAX + 20);
    const out = deriveScratchTitle(long);
    expect(out).toHaveLength(SCRATCH_TITLE_MAX + 1); // + the ellipsis
    expect(out.endsWith("…")).toBe(true);
    // Exactly at the limit is NOT truncated.
    const exact = "b".repeat(SCRATCH_TITLE_MAX);
    expect(deriveScratchTitle(exact)).toBe(exact);
  });

  it("strips heading marks and comment leaders on EVERY line it takes", () => {
    expect(deriveScratchTitle("# Fix the resume race")).toBe("Fix the resume race");
    expect(deriveScratchTitle("### Deep heading")).toBe("Deep heading");
    expect(deriveScratchTitle("// TODO: swap the uuids")).toBe("TODO: swap the uuids");
    expect(deriveScratchTitle("- a bullet")).toBe("a bullet");
    expect(deriveScratchTitle("> quoted")).toBe("quoted");
    // Not just the first: a note is mostly bullets, and the markers would
    // otherwise eat half the pill.
    expect(deriveScratchTitle("todo\n- one\n- two")).toBe("todo one two");
  });

  it("skips a line that is only punctuation and collapses whitespace", () => {
    // A `---` rule or a bare `#` divider is not title material.
    expect(deriveScratchTitle("---\nthe real title")).toBe("the real title");
    expect(deriveScratchTitle("#\ntitle after a bare hash")).toBe("title after a bare hash");
    expect(deriveScratchTitle("two\t\t spaced   words")).toBe("two spaced words");
    // Newlines never survive into a title: a pill is one line.
    expect(deriveScratchTitle("a\nb")).not.toContain("\n");
  });

  it("is stable for the same input, so the unchanged-bail actually bails", () => {
    // The debounced derivation writes through a store setter; an unstable
    // result would churn the whole app state on every keystroke
    // (docs/performance.md bear trap 8).
    const s = "# A note\nbody\nmore body";
    expect(deriveScratchTitle(s)).toBe(deriveScratchTitle(s));
  });
});

describe("scratchFilenameSlug", () => {
  it("slugs a derived title", () => {
    expect(scratchFilenameSlug("Fix the resume race")).toBe("fix-the-resume-race");
    expect(scratchFilenameSlug("TODO: swap the uuids")).toBe("todo-swap-the-uuids");
  });

  it("never returns an empty or edge-punctuated name", () => {
    expect(scratchFilenameSlug("")).toBe("untitled");
    expect(scratchFilenameSlug("!!!")).toBe("untitled");
    expect(scratchFilenameSlug(SCRATCH_UNTITLED)).toBe("untitled");
    expect(scratchFilenameSlug("  spaced  ")).toBe("spaced");
    // A truncated title carries the ellipsis; it must not survive into a
    // filename.
    expect(scratchFilenameSlug("a long note…")).toBe("a-long-note");
  });

  it("caps the length so a rambling first line can't make a 200-char filename", () => {
    expect(scratchFilenameSlug("word ".repeat(40)).length).toBeLessThanOrEqual(48);
    expect(scratchFilenameSlug("word ".repeat(40)).endsWith("-")).toBe(false);
  });
});
