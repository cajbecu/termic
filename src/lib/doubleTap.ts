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

/**
 * Feed every keydown here. Returns the next state, and whether this press
 * completed a double tap.
 *
 * `key` is the event's own key. Anything that is not Shift resets the state:
 * that is what stops capitals, and any shortcut involving Shift, from being
 * read as the first half of a double tap.
 */
export function trackDoubleShift(
  state: TapState,
  key: string,
  now: number,
  opts: { repeat?: boolean; otherModifier?: boolean } = {},
): { state: TapState; fired: boolean } {
  if (key !== "Shift") return { state: NO_TAPS, fired: false };
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
