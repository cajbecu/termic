// Startup timing marks, read by the nightly perf job (perf/specs/startup.perf.ts)
// and by `make perf`. See docs/research/perf-ci.md for why this exists and what
// it is allowed to claim.
//
// TWO numbers, because they answer different questions and only one of them is
// visible from JS:
//
//   webviewToFirstPaintMs — `performance.timeOrigin` → first paint. This is the
//     half termic controls: bundle parse, React mount, store hydration, the
//     lazy-chunk boundaries. Regressions here are ours.
//   bootToFirstPaintMs    — process spawn → first paint, via the Rust `BOOT`
//     Instant. This is what a user actually waits through. It includes Tauri
//     and WKWebView fixed cost we mostly cannot move, so it is the honest
//     headline but the noisier signal.
//
// Reporting only the first would flatter us; reporting only the second would
// hide our own regressions inside platform cost. So: both, always, labelled.

import { invoke } from "@tauri-apps/api/core";

export interface PerfMarks {
  /** epoch ms, from `performance.timeOrigin`. */
  timeOrigin: number;
  /** `performance.timeOrigin` → first paint. */
  webviewToFirstPaintMs: number | null;
  /** Process spawn → first paint, from the Rust boot Instant. rAF path only. */
  bootToFirstPaintMs: number | null;
  /** `first-contentful-paint` from the Paint Timing API, relative to
   *  timeOrigin. Engine-recorded, so unlike the rAF marks it survives an
   *  occluded window. This is the PRIMARY startup metric. */
  firstContentfulPaintMs: number | null;
  /** Process spawn → first contentful paint. Works on both paths. */
  bootToFirstContentfulPaintMs: number | null;
  /** WebGL renderer string, or null if no context. Answers "does the CI runner
   *  give WKWebView a hardware context, or is it falling back to software?" —
   *  the open question that decides whether frame-gap numbers mean anything. */
  webglRenderer: string | null;
  /** Which path published these marks. `timeout` means rAF never fired (an
   *  occluded window freezes it), so the paint timings are null rather than
   *  wrong, and only `webglRenderer` is trustworthy. */
  firstPaintVia: "raf" | "timeout" | null;
}

declare global {
  interface Window {
    __termicPerf?: PerfMarks;
  }
}

const marks: PerfMarks = {
  timeOrigin: typeof performance !== "undefined" ? performance.timeOrigin : 0,
  webviewToFirstPaintMs: null,
  bootToFirstPaintMs: null,
  firstContentfulPaintMs: null,
  bootToFirstContentfulPaintMs: null,
  webglRenderer: null,
  firstPaintVia: null,
};

/** Read the renderer string WKWebView actually gave us. Uses its own throwaway
 *  canvas: the terminal's context is created by xterm's WebGL addon and must
 *  not be touched. Best-effort by design, a probe must never break startup. */
function probeWebglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return null;
    const ext = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
    const renderer = ext
      ? (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).RENDERER);
    // Drop the context rather than waiting for GC to reclaim the GPU resources.
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" ? renderer : null;
  } catch {
    return null;
  }
}

/** `first-contentful-paint` from the Paint Timing API, in ms since timeOrigin.
 *  Null if the engine recorded no paint entry. */
function readFcpMs(): number | null {
  try {
    const entries = performance.getEntriesByType("paint");
    const fcp = entries.find(e => e.name === "first-contentful-paint")
      ?? entries.find(e => e.name === "first-paint");
    return fcp ? Math.round(fcp.startTime) : null;
  } catch {
    return null;
  }
}

let recorded = false;

/** How long to wait for the double-rAF before giving up on it. */
const RAF_FALLBACK_MS = 8_000;

/** Call once, from the first component render that means "the user can see the
 *  app". Idempotent: only the first call counts, later ones are ignored so a
 *  re-render or an HMR reload cannot overwrite a real cold-start number. */
export function recordFirstPaint(): void {
  if (recorded) return;
  recorded = true;

  let settled = false;

  const finish = (via: "raf" | "timeout") => {
    if (settled) return;
    settled = true;
    marks.firstPaintVia = via;

    // On the timeout path NO frame was painted, so there is no first-paint
    // time to report. Emitting `RAF_FALLBACK_MS` here would look like a
    // measurement and be a fabrication, so the timings stay null and the
    // `via` field says why. The WebGL probe is still worth taking: it does
    // not depend on a frame, and it answers the hardware-context question.
    if (via === "raf") {
      marks.webviewToFirstPaintMs = Math.round(performance.now());
    }
    // Engine-recorded paint timing. Independent of rAF, so it survives the
    // occluded-window case that makes the rAF path useless under WebdriverIO,
    // and it is the more accurate number anyway: the engine stamps the actual
    // paint rather than the frame callback after it.
    marks.firstContentfulPaintMs = readFcpMs();
    marks.webglRenderer = probeWebglRenderer();
    window.__termicPerf = marks;

    // Fire-and-forget: the Rust half is a nice-to-have and must never delay
    // or break paint. Older builds without the command just leave it null.
    invoke<number>("perf_boot_elapsed_ms")
      .then(ms => {
        if (typeof ms !== "number" || ms <= 0) return;
        if (via === "raf") marks.bootToFirstPaintMs = ms;
        // Back-date to the paint: `ms` is elapsed AT THIS MOMENT, which on the
        // timeout path is RAF_FALLBACK_MS after the fact. Subtracting the time
        // since the recorded paint recovers spawn → paint on either path.
        const fcp = marks.firstContentfulPaintMs;
        if (fcp !== null) {
          marks.bootToFirstContentfulPaintMs = Math.max(
            0, Math.round(ms - (performance.now() - fcp)),
          );
        }
        window.__termicPerf = marks;
      })
      .catch(() => { /* command absent; webview-relative numbers still stand */ });
  };

  // Two rAFs: the first fires before the frame this render produces is painted,
  // the second after the compositor has actually shown it. One rAF measures
  // "React finished", which is earlier than what the user sees.
  requestAnimationFrame(() => requestAnimationFrame(() => finish("raf")));

  // WKWebView FREEZES rAF for an occluded or off-Space window (docs/automation.md),
  // which is the normal state for a window driven by WebdriverIO. Without this
  // the marks object is never published at all and the perf spec times out
  // waiting for it, reporting nothing including the WebGL fact. Same shape as
  // TerminalPane's rAF gate, and load-bearing for the same reason.
  setTimeout(() => finish("timeout"), RAF_FALLBACK_MS);
}

/** Current marks. `null` fields mean "not measured yet", never "zero". */
export function getPerfMarks(): PerfMarks {
  return marks;
}
