import { describe, it, expect } from "vitest";
import { fitRows } from "@/lib/fitRows";

// These textareas use `field-sizing: content`, which treats an empty field as
// zero lines, so a multi-line placeholder scrolled inside a 2-row box. They
// only looked right once you had typed something, which is backwards: the
// placeholder does its most important work while the field is still empty, and
// several of these placeholders ARE the agent's live built-in patterns, so a
// clipped one hides the thing it exists to show.
describe("fitRows", () => {
  it("fits a multi-line placeholder in an EMPTY field", () => {
    expect(fitRows("", "a\nb\nc")).toBe(3);
    expect(fitRows("", "Ready\n done\nawaiting input")).toBe(3);
  });

  it("keeps a two-row floor so a one-line field is not cramped", () => {
    expect(fitRows("", "one line")).toBe(2);
    expect(fitRows("", "")).toBe(2);
    expect(fitRows("", undefined)).toBe(2);
  });

  it("fits the VALUE too, so it survives field-sizing being dropped", () => {
    expect(fitRows("a\nb\nc\nd", "x")).toBe(4);
  });

  it("takes whichever side is longer", () => {
    expect(fitRows("a\nb\nc\nd\ne", "x\ny")).toBe(5);
    expect(fitRows("a", "x\ny\nz\nw")).toBe(4);
  });

  it("caps, so one inherited pattern list cannot become the whole page", () => {
    expect(fitRows("", Array.from({ length: 40 }, (_, i) => `p${i}`).join("\n"))).toBe(8);
    expect(fitRows(Array.from({ length: 40 }, (_, i) => `v${i}`).join("\n"), "")).toBe(8);
  });
});
