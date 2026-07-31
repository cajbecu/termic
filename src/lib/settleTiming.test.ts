// Guards the timing floor windowless mode depends on.
//
// A hidden webview has its timers clamped to 1 Hz by WebKit (measured; see
// docs/performance.md bear trap 2b). The settle signal these knobs drive is
// what `--wait`, `termic list` and the work-done indicator all ride, so a knob
// tuned under the clamp means Termic silently stops reporting that agents
// finished, but ONLY while it has no window. Nothing else catches that: it
// compiles, the app looks fine on screen, and the e2e suite would need a
// windowless run with a real agent to notice.
//
// These asserts are deliberately about the FLOOR, not the current values. Tune
// the knobs freely above the floor; a change that drops below it should have to
// delete a test that says why.

import { describe, expect, it } from "vitest";
import {
  QUIET_MS,
  SAMPLE_MS,
  SCROLLBACK_STABLE_SAMPLES,
  SETTLE_SAMPLES,
} from "./settleTiming";

/** WebKit's background-timer clamp for a hidden webview. */
const HIDDEN_WEBVIEW_CLAMP_MS = 1000;

describe("settle timing survives the hidden-webview timer clamp", () => {
  it("samples no faster than the 1 Hz clamp", () => {
    // THE load-bearing one. SAMPLE_MS is the period of the single setInterval
    // that runs every settle path (byte-quiet, scrollback stability, hash
    // stability, both ceilings). Under the clamp the sampler runs slower than
    // it thinks it does, and `--wait` hangs while windowless.
    expect(SAMPLE_MS).toBeGreaterThanOrEqual(HIDDEN_WEBVIEW_CLAMP_MS);
  });

  it("keeps the byte-quiet threshold observable by the sampler", () => {
    // QUIET_MS is wall-clock, so the clamp does not change its meaning - but a
    // threshold shorter than the sampling period cannot be observed reliably,
    // clamped or not.
    expect(QUIET_MS).toBeGreaterThanOrEqual(SAMPLE_MS);
  });

  it("keeps the derived stillness windows above the clamp", () => {
    // Counts are clamp-immune on their own, but the windows they produce are
    // SAMPLES * SAMPLE_MS - so the floor can be undercut indirectly by
    // shrinking a count rather than the period.
    expect(SETTLE_SAMPLES * SAMPLE_MS).toBeGreaterThanOrEqual(HIDDEN_WEBVIEW_CLAMP_MS);
    expect(SCROLLBACK_STABLE_SAMPLES * SAMPLE_MS).toBeGreaterThanOrEqual(
      HIDDEN_WEBVIEW_CLAMP_MS,
    );
  });
});
