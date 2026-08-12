// Cold start to first paint, plus the WebGL renderer fact.
//
// The renderer string is the load-bearing part of this spec, not a footnote.
// It answers the open question from docs/research/perf-ci.md: does WKWebView
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
  webglRenderer: string | null;
}

describe("startup", () => {
  it("records first paint and the WebGL renderer", async () => {
    // The session is already up by the time a spec runs, so the marks were
    // taken during the launch the service performed. Poll rather than assume:
    // bootToFirstPaintMs lands one IPC round-trip after the paint marks.
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => !!(window as any).__termicPerf?.webviewToFirstPaintMs)) === true,
      { timeout: 30_000, timeoutMsg: "app never recorded a first-paint mark" },
    );

    // One extra beat for the async Rust round-trip to land. Its absence is not
    // fatal (the webview-relative number still stands), so this does not wait
    // on it hard.
    await browser.pause(500);

    const marks = (await browser.execute(() => (window as any).__termicPerf)) as PerfMarks;

    record({
      metric: "startup.webviewToFirstPaintMs",
      value: marks.webviewToFirstPaintMs,
      unit: "ms",
      note: "performance.timeOrigin to first painted frame; the half termic owns",
    });
    record({
      metric: "startup.bootToFirstPaintMs",
      value: marks.bootToFirstPaintMs,
      unit: "ms",
      note: marks.bootToFirstPaintMs === null
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
