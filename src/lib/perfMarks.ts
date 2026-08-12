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
  /** Process spawn → first paint, from the Rust boot Instant. */
  bootToFirstPaintMs: number | null;
  /** WebGL renderer string, or null if no context. Answers "does the CI runner
   *  give WKWebView a hardware context, or is it falling back to software?" —
   *  the open question that decides whether frame-gap numbers mean anything. */
  webglRenderer: string | null;
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
  webglRenderer: null,
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

let recorded = false;

/** Call once, from the first component render that means "the user can see the
 *  app". Idempotent: only the first call counts, later ones are ignored so a
 *  re-render or an HMR reload cannot overwrite a real cold-start number. */
export function recordFirstPaint(): void {
  if (recorded) return;
  recorded = true;

  // Two rAFs: the first fires before the frame this render produces is painted,
  // the second after the compositor has actually shown it. One rAF measures
  // "React finished", which is earlier than what the user sees.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      marks.webviewToFirstPaintMs = Math.round(performance.now());
      marks.webglRenderer = probeWebglRenderer();
      window.__termicPerf = marks;

      // Fire-and-forget: the Rust half is a nice-to-have and must never delay
      // or break paint. Older builds without the command just leave it null.
      invoke<number>("perf_boot_elapsed_ms")
        .then(ms => {
          marks.bootToFirstPaintMs = typeof ms === "number" && ms > 0 ? ms : null;
          window.__termicPerf = marks;
        })
        .catch(() => { /* command absent; webview-relative number still stands */ });
    });
  });
}

/** Current marks. `null` fields mean "not measured yet", never "zero". */
export function getPerfMarks(): PerfMarks {
  return marks;
}
