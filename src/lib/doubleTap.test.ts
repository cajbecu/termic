import { describe, it, expect } from "vitest";
import { trackDoubleShift, NO_TAPS, DOUBLE_TAP_MS } from "./doubleTap";

// The timing is the easy part. What matters is everything that must CANCEL
// the sequence: without that, typing "Hello World" opens a dialog over what
// you are writing.

describe("double-Shift", () => {
  it("fires on two presses inside the window", () => {
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000);
    expect(first.fired).toBe(false);
    expect(trackDoubleShift(first.state, "Shift", 1200).fired).toBe(true);
  });

  it("does not fire when the two are too far apart", () => {
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000);
    const late = trackDoubleShift(first.state, "Shift", 1000 + DOUBLE_TAP_MS + 1);
    expect(late.fired).toBe(false);
    // ...and that press becomes the new first half, rather than being lost.
    expect(trackDoubleShift(late.state, "Shift", 1000 + DOUBLE_TAP_MS + 100).fired).toBe(true);
  });

  it("is cancelled by any other key", () => {
    // Typing a capital: Shift, then the letter. The letter resets it, so the
    // NEXT capital's Shift cannot complete a tap.
    const shift = trackDoubleShift(NO_TAPS, "Shift", 1000);
    const letter = trackDoubleShift(shift.state, "H", 1050);
    expect(letter.state).toEqual(NO_TAPS);
    expect(trackDoubleShift(letter.state, "Shift", 1100).fired).toBe(false);
  });

  it("ignores the repeats from holding Shift down", () => {
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000);
    const held = trackDoubleShift(first.state, "Shift", 1100, { repeat: true });
    expect(held.fired).toBe(false);
    // The held-down press must not become the first half either, or releasing
    // and pressing once would fire.
    expect(held.state).toEqual(first.state);
  });

  it("ignores a Shift that is part of a chord", () => {
    // ⇧⌘P and friends: the Shift is a modifier, not a gesture.
    const chord = trackDoubleShift(NO_TAPS, "Shift", 1000, { otherModifier: true });
    expect(chord.state).toEqual(NO_TAPS);
    expect(trackDoubleShift(chord.state, "Shift", 1100).fired).toBe(false);
  });
});
