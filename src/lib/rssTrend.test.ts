// Tests for the nightly memory suite's two pure functions.
//
// They live under src/ because that is what `vitest.config.ts` collects, and
// they are worth collecting: the metric they back reported -88.8 MiB of
// "growth" on its first real run, which is the failure mode of a number nobody
// could test. These are count-and-invariant assertions, the class that gates a
// PR (docs/perf-ci.md), so a future edit to the settle rule has to keep them.

import { describe, it, expect } from "vitest";
import { isFlat, trend } from "../../perf/nightly/proc";

describe("trend", () => {
  it("reads a rising series as a positive slope", () => {
    // 2 MiB per cycle, exactly.
    const ys = [100, 102, 104, 106, 108, 110];
    const t = trend(ys);
    expect(t.slope).toBeCloseTo(2, 6);
    expect(t.r2).toBeCloseTo(1, 6);
    expect(t.n).toBe(6);
  });

  it("reads a flat series as no slope, and does NOT call it a perfect fit", () => {
    // r2 of a flat line is the trap: there is no variance to explain, and
    // reporting 1.0 would dress "the number never moved" up as a confident
    // trend when the two mean opposite things to a reader.
    const t = trend([500, 500, 500, 500]);
    expect(t.slope).toBe(0);
    expect(t.r2).toBe(0);
  });

  it("is not fooled by noise around a flat mean", () => {
    // Symmetric jitter: the slope must stay near zero and the fit must be poor,
    // which together are what the spec's noise floor reads.
    const t = trend([500, 508, 496, 504, 499, 503, 497, 501]);
    expect(Math.abs(t.slope)).toBeLessThan(0.5);
    expect(t.r2).toBeLessThan(0.3);
  });

  it("survives a one-off step without calling it a trend", () => {
    // A single allocation partway through (a lazy chunk loading) moves the mean
    // but is not a per-cycle leak. The slope is non-zero but the fit is weak,
    // which is exactly the pair of numbers the report prints side by side.
    const t = trend([100, 100, 100, 140, 140, 140]);
    expect(t.slope).toBeGreaterThan(0);
    expect(t.r2).toBeLessThan(0.9);
  });

  it("degenerates safely on too few samples", () => {
    expect(trend([]).slope).toBe(0);
    expect(trend([42]).slope).toBe(0);
    expect(trend([42]).n).toBe(1);
  });
});

describe("isFlat", () => {
  it("rejects a monotonic decay that fits inside the spread", () => {
    // THE regression. Four samples falling 2 MiB each span 6 MiB, so the old
    // `max - min <= 8` accepted them as settled while RSS was shedding
    // ~120 MiB/minute. That is how a baseline got taken mid startup-decay and
    // the run reported negative growth.
    expect(isFlat([1000, 998, 996, 994], 8)).toBe(false);
  });

  it("accepts jitter that stays put", () => {
    expect(isFlat([1000, 1003, 999, 1001, 1000, 1002], 8)).toBe(true);
  });

  it("rejects a rise as readily as a decay", () => {
    expect(isFlat([994, 996, 998, 1000], 8)).toBe(false);
  });

  it("still enforces the spread, not only the endpoints", () => {
    // Ends level, middle wild: net drift is 0 but the window is not flat, and
    // sampling a peak or a trough there would be luck.
    expect(isFlat([1000, 1040, 960, 1000], 8)).toBe(false);
  });

  it("needs at least two samples to claim anything", () => {
    expect(isFlat([], 8)).toBe(false);
    expect(isFlat([1000], 8)).toBe(false);
  });
});
