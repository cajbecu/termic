// Cold start to first paint, plus the WebGL renderer fact.
//
// The renderer string is the load-bearing part of this spec, not a footnote.
// It answers the open question from docs/perf-ci.md: does WKWebView
// get a hardware context on a macos-14 runner, or does it fall back to
// software? If it is software, every frame-timing number from this runner
// describes a software rasteriser rather than termic, and the jank spec is
// meaningless. Recording it every night means we notice if that ever changes
// under us.

import { fact, record } from "../report.js";

interface PerfMarks {
  timeOrigin: number;
  webviewToFirstPaintMs: number | null;
  bootToFirstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  bootToFirstContentfulPaintMs: number | null;
  webglRenderer: string | null;
  firstPaintVia: "raf" | "timeout" | null;
}

describe("startup", () => {
  it("records first paint and the WebGL renderer", async () => {
    // Wait for the marks to be PUBLISHED, not for a paint time to be present.
    // A WebdriverIO-driven window is usually occluded, and WKWebView freezes
    // rAF for an occluded window (docs/automation.md), so the paint timings
    // are legitimately null on that path while the WebGL fact is still valid.
    // Waiting on `webviewToFirstPaintMs` instead made this spec fail outright
    // and threw away the renderer string with it.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => !!(window as any).__termicPerf?.firstPaintVia)) === true,
      { timeout: 30_000, timeoutMsg: "app never published perf marks at all" },
    );

    // One extra beat for the async Rust round-trip to land. Its absence is not
    // fatal (the webview-relative number still stands), so this does not wait
    // on it hard.
    await browser.pause(500);

    const marks = (await browser.execute(() => (window as any).__termicPerf)) as PerfMarks;

    const viaRaf = marks.firstPaintVia === "raf";
    fact("firstPaintVia", marks.firstPaintVia ?? "unknown");

    // The PRIMARY startup rows. Engine-recorded paint timing, so these survive
    // the occluded window that freezes rAF under WebdriverIO. The two rAF rows
    // below are kept as corroboration and are simply null when it never fired.
    record({
      metric: "startup.firstContentfulPaintMs",
      value: marks.firstContentfulPaintMs,
      unit: "ms",
      note: "Paint Timing API, relative to timeOrigin; rAF-independent",
    });
    record({
      metric: "startup.bootToFirstContentfulPaintMs",
      value: marks.bootToFirstContentfulPaintMs,
      unit: "ms",
      note: "process spawn to first contentful paint; the number a user waits through",
    });

    record({
      metric: "startup.webviewToFirstPaintMs",
      value: marks.webviewToFirstPaintMs,
      unit: "ms",
      note: viaRaf
        ? "performance.timeOrigin to first painted frame; the half termic owns"
        : "not measured: rAF frozen for an occluded window",
    });
    record({
      metric: "startup.bootToFirstPaintMs",
      value: marks.bootToFirstPaintMs,
      unit: "ms",
      note: !viaRaf
        ? "not measured: rAF frozen for an occluded window"
        : marks.bootToFirstPaintMs === null
          ? "Rust boot command unavailable in this build"
          : "process spawn to first painted frame; includes Tauri/WKWebView fixed cost",
    });

    fact("webglRenderer", marks.webglRenderer ?? "none (no WebGL context)");
    fact("platform", process.platform);
    fact(
      "hardwareWebgl",
      marks.webglRenderer === null
        ? "NO CONTEXT — treat all frame-timing numbers as invalid"
        : /software|swiftshader|llvmpipe/i.test(marks.webglRenderer)
          ? "SOFTWARE — frame-timing numbers describe the rasteriser, not termic"
          : "looks hardware-backed",
    );
  });
});
