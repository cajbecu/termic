import { describe, it, expect } from "vitest";
import { trackDoubleShift, NO_TAPS, DOUBLE_TAP_MS, KEY_LOCATION_RIGHT } from "./doubleTap";

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

  it("ignores the RIGHT Shift under leftOnly", () => {
    // The Shift a touch typist holds for left-hand capitals, and where the
    // accidental fires came from. Two of them are not the gesture.
    const o = { leftOnly: true, location: KEY_LOCATION_RIGHT };
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000, o);
    expect(first.fired).toBe(false);
    expect(trackDoubleShift(first.state, "Shift", 1100, o).fired).toBe(false);
  });

  it("fires on two LEFT Shifts under leftOnly", () => {
    const o = { leftOnly: true, location: 1 };
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000, o);
    expect(trackDoubleShift(first.state, "Shift", 1100, o).fired).toBe(true);
  });

  it("lets the right Shift cancel a half-finished tap under leftOnly", () => {
    // Left, right, left inside the window is somebody typing, not somebody
    // asking for a dialog, so the right one resets rather than being ignored.
    const left = trackDoubleShift(NO_TAPS, "Shift", 1000, { leftOnly: true, location: 1 });
    const right = trackDoubleShift(left.state, "Shift", 1050, {
      leftOnly: true, location: KEY_LOCATION_RIGHT,
    });
    expect(right.state).toEqual(NO_TAPS);
    expect(trackDoubleShift(right.state, "Shift", 1100, { leftOnly: true, location: 1 }).fired)
      .toBe(false);
  });

  it("takes either Shift when leftOnly is off", () => {
    // The "any" mode, which is JetBrains' own behaviour.
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000, { location: KEY_LOCATION_RIGHT });
    expect(trackDoubleShift(first.state, "Shift", 1100, { location: KEY_LOCATION_RIGHT }).fired)
      .toBe(true);
  });

  it("still fires under leftOnly where the location is not reported", () => {
    // Synthetic events carry location 0. Demanding a left-hand 1 would turn
    // the gesture off entirely there, which is worse than firing.
    const o = { leftOnly: true, location: 0 };
    const first = trackDoubleShift(NO_TAPS, "Shift", 1000, o);
    expect(trackDoubleShift(first.state, "Shift", 1100, o).fired).toBe(true);
  });

  it("ignores a Shift that is part of a chord", () => {
    // ⇧⌘P and friends: the Shift is a modifier, not a gesture.
    const chord = trackDoubleShift(NO_TAPS, "Shift", 1000, { otherModifier: true });
    expect(chord.state).toEqual(NO_TAPS);
    expect(trackDoubleShift(chord.state, "Shift", 1100).fired).toBe(false);
  });
});
