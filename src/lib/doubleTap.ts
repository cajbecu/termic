// Double-Shift, the way JetBrains opens Search Everywhere.
//
// A pure decision so the fiddly part is testable: the fiddly part is NOT the
// timing, it is everything that must cancel the sequence. Typing a capital
// letter is Shift-down, key, Shift-up — and if a stray key between two Shifts
// did not reset the tracker, writing "Hello World" would open a dialog over
// what you were typing.

export interface TapState {
  /** When the last qualifying Shift press happened, in ms. */
  lastAt: number;
}

/** How long the two presses may be apart. JetBrains uses roughly this; longer
 *  starts catching deliberate, unrelated Shift presses. */
export const DOUBLE_TAP_MS = 350;

export const NO_TAPS: TapState = { lastAt: 0 };

/** `KeyboardEvent.location` for the right-hand copy of a key. */
export const KEY_LOCATION_RIGHT = 2;

/**
 * Feed every keydown here. Returns the next state, and whether this press
 * completed a double tap.
 *
 * `key` is the event's own key. Anything that is not Shift resets the state:
 * that is what stops capitals, and any shortcut involving Shift, from being
 * read as the first half of a double tap.
 *
 * With `leftOnly`, the right-hand Shift does not count. It is the Shift a
 * touch typist holds for left-hand capitals, which is where the accidental
 * fires come from. The test is "not the right-hand one" rather than
 * "location === 1" deliberately: a synthetic event carries location 0, and a
 * rule demanding 1 would turn the gesture off entirely wherever the location
 * is not reported, which is a much worse failure than firing on an unlocated
 * key.
 */
export function trackDoubleShift(
  state: TapState,
  key: string,
  now: number,
  opts: { repeat?: boolean; otherModifier?: boolean; location?: number; leftOnly?: boolean } = {},
): { state: TapState; fired: boolean } {
  if (key !== "Shift") return { state: NO_TAPS, fired: false };
  // A right Shift under leftOnly is a real keypress that is not this gesture,
  // so it CANCELS a half-finished one rather than being ignored:
  // left-then-right-then-left inside the window is somebody typing, not
  // somebody asking for a dialog.
  if (opts.leftOnly && opts.location === KEY_LOCATION_RIGHT) {
    return { state: NO_TAPS, fired: false };
  }
  // Holding Shift down repeats the keydown; only a real second press counts.
  if (opts.repeat) return { state, fired: false };
  // ⇧⌘P is not the start of anything: a Shift held with another modifier is
  // part of a chord.
  if (opts.otherModifier) return { state: NO_TAPS, fired: false };
  if (state.lastAt && now - state.lastAt <= DOUBLE_TAP_MS) {
    return { state: NO_TAPS, fired: true };
  }
  return { state: { lastAt: now }, fired: false };
}
