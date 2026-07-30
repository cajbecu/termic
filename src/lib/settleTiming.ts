// Settle-detection timing knobs, extracted so they can be asserted on without
// importing TerminalPane (which would drag xterm + the WebGL addon into the
// vitest environment just to read four numbers). See settleTiming.test.ts.
//
// WHY THIS MODULE EXISTS, and the constraint every value here is under:
//
// Windowless mode leaves the webview alive but hidden, and WebKit clamps timers
// in a hidden webview to a 1 Hz floor (measured; docs/performance.md bear trap
// 2b). `--wait`, `termic list` and the work-done indicator all ride the settle
// signal these knobs drive, so anything at or below ~1000ms silently stops
// being observable the moment Termic has no window. Nothing in the type system
// or the app catches that: the app just stops reporting that agents finished.
//
// There is exactly ONE timer that matters: the single `setInterval` in
// TerminalPane's settle effect, whose period is SAMPLE_MS. Every settle path
// (byte-quiet, scrollback stability, hash stability, both ceilings) runs inside
// that one callback. Everything else here is either a COUNT of those samples or
// a wall-clock threshold compared against `Date.now()` deltas, so none of them
// are clamp-sensitive on their own - but a threshold shorter than the sampling
// period cannot be observed reliably either way, and a count multiplied by
// SAMPLE_MS must still clear the floor.

/**
 * Period of the settle sampler. MUST stay >= 1000ms: a hidden webview clamps
 * timers to 1 Hz, and a period under the clamp means the sampler silently runs
 * slower than it reads, so every derived window below stretches with it.
 */
export const SAMPLE_MS = 3000;

/**
 * Consecutive identical-hash samples before a working tab is called settled.
 * Net stillness window = SETTLE_SAMPLES * SAMPLE_MS.
 */
export const SETTLE_SAMPLES = 2;

/**
 * Byte-quiet fallback: no PTY output for this long, while "working", forces
 * done. Wall-clock (compared against `lastOutputAt`), so the clamp does not
 * change its meaning - but it has to exceed SAMPLE_MS to be seen at all.
 */
export const QUIET_MS = 4_000;

/**
 * Consecutive samples with no NEW scrollback lines before declaring done from
 * scrollback stability. Tolerant of slow tool output; strict enough to fire
 * even when a status counter keeps ticking.
 */
export const SCROLLBACK_STABLE_SAMPLES = 3;
