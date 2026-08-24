// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onReturnFromAway, initUserPresence, AWAY_MS } from "./userPresence";

// The return-from-absence signal the terminal renderer rebuilds on. Pinned
// here: which events count as presence, the threshold, and that a subscriber
// can leave.

describe("onReturnFromAway", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initUserPresence();
    window.dispatchEvent(new KeyboardEvent("keydown"));  // stamp the fake clock
  });
  afterEach(() => vi.useRealTimers());

  it("fires on the first input after AWAY_MS, with the gap", () => {
    const seen: number[] = [];
    const off = onReturnFromAway(ms => seen.push(ms));
    vi.advanceTimersByTime(AWAY_MS - 1);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(AWAY_MS);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(seen).toEqual([AWAY_MS]);
    off();
  });

  it.each([
    ["pointerdown", () => window.dispatchEvent(new Event("pointerdown"))],
    ["wheel", () => window.dispatchEvent(new Event("wheel"))],
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("%s counts as presence", (_name, fire) => {
    const cb = vi.fn();
    const off = onReturnFromAway(cb);
    vi.advanceTimersByTime(AWAY_MS);
    fire();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it("fires once per return, not once per keystroke", () => {
    const cb = vi.fn();
    const off = onReturnFromAway(cb);
    vi.advanceTimersByTime(AWAY_MS);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  // Asserted on the install itself: the DOM dedupes an identical listener
  // and a second seen() sees away=0, so no downstream effect can tell a
  // double install apart from a single one.
  it("installs its listeners once", () => {
    const add = vi.spyOn(window, "addEventListener");
    initUserPresence();  // second call, on top of beforeEach's
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it("stops after unsubscribe", () => {
    const cb = vi.fn();
    onReturnFromAway(cb)();
    vi.advanceTimersByTime(AWAY_MS);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(cb).not.toHaveBeenCalled();
  });
});
