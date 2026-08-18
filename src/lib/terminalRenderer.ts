// WebGL terminal renderer setup. Shared by TerminalPane + AuxTerminal.
//
// TEMP: also installs a diagnostic — `window.__termicDumpRenderer()`
// (call it from the Web Inspector console) dumps the WebGL renderer's
// full dimension state. Diffing that between the thin-launch state and
// the crisp after-monitor-move state pinpoints the exact wrong value.
// Remove once the retina-thinness bug is fixed.

import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import type { Terminal } from "@xterm/xterm";
import { usePrefs } from "@/store/prefs";
import { terminalFontReady, isTerminalFontReady } from "@/lib/terminalFontReady";
import { keepAtlasCanvasConnected } from "@/lib/atlasCanvasGuard";
import * as ipc from "@/lib/ipc";

function dumpRenderer(addon: WebglAddon | CanvasAddon | null): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r: any = (addon as any)?._renderer;
  if (!r) { console.log("[termic renderer] no WebGL renderer"); return; }
  console.log("[termic renderer] " + JSON.stringify({
    windowDPR: window.devicePixelRatio,
    coreBrowserDPR: r._coreBrowserService?.dpr,
    rendererDPR: r._devicePixelRatio,
    charSize: { w: r._charSizeService?.width, h: r._charSizeService?.height },
    canvasBacking: { w: r._canvas?.width, h: r._canvas?.height },
    canvasCSS: { w: r._canvas?.style?.width, h: r._canvas?.style?.height },
    dimsDeviceChar: r.dimensions?.device?.char,
    dimsDeviceCell: r.dimensions?.device?.cell,
    dimsCSSCell: r.dimensions?.css?.cell,
  }, null, 2));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Load the renderer named by the `terminalRenderer` pref onto `term`.
 *  Returns a disposable: call `dispose()` BEFORE `term.dispose()` so the
 *  render loop can't fire on a half-disposed terminal. On "dom", or if the
 *  addon throws (unsupported), nothing is loaded and xterm's built-in DOM
 *  renderer remains. Read once at mount; changing the pref takes effect on
 *  the next terminal spawn (relaunch to switch every open terminal).
 *
 *  GH #140 reported the macOS 26 WebGL surface costing ~33pp of WindowServer
 *  while idle and asked for a way off it. Re-measuring on an M1 Max at a
 *  comparable canvas size (~3.4M device px) did not reproduce that: WebGL
 *  costs ~1pp more WindowServer than DOM, and DOM's total is actually WORSE
 *  once WebContent and WebKit's GPU process are counted, which the issue did
 *  not measure. Under sustained output WebGL is ~2.7x cheaper than either
 *  alternative. So WebGL stays the default and this pref is a compatibility
 *  escape hatch (software rasterizers on Linux/WebKitGTK, driver bugs), NOT a
 *  battery lever. Canvas is the one option that genuinely lowers idle cost,
 *  and it pays for that under load.
 *
 *  The cost also does NOT stack per surface, which the earlier "~10pp per
 *  idle visible terminal" note here got wrong in kind rather than in degree.
 *  Ten split terminals cost +0.8pp of WindowServer and +0.2pp of GPU over
 *  one (n=2 each, same maximized window), against the ~70pp a per-surface
 *  cost would predict. It tracks total canvas AREA, which the window size
 *  fixes, so splitting a window ten ways divides the same pixels rather than
 *  multiplying them. Practical consequence: window size and display scaling
 *  are the variables that matter here, not how many terminals are on screen. */
/** GH #70: the bundled JetBrains Mono is a lazy @font-face; xterm's WebGL atlas
 *  keys glyphs per (char, fg, bg, ext) with no font in the key, so a glyph
 *  rasterized against the fallback stays wrong-height until the cell happens to
 *  re-rasterize (selection changes the bg, new key, correct glyph, which is why
 *  selecting text "fixed" it).
 *
 *  The previous gate polled `document.fonts` for the family, but check() and
 *  load() both report a family READY before it is registered in the FontFaceSet
 *  (check() returns true and load() resolves with zero faces for an unregistered
 *  family, reproduced on WKWebView). Since fontsource registers "JetBrains Mono"
 *  via async CSS @font-face, that vacuous window is the poison window on a cold
 *  spawn. So correctness now comes from loadTerminalRenderer holding the WebGL
 *  attach until `terminalFontReady` resolves: real FontFace handles we own and
 *  await (lib/terminalFontReady). The atlas is then built against the real face
 *  and never poisoned, so nothing is cleared under a live renderer (the
 *  disproven #70 path). This fn is the spawn-side gate: it waits the same
 *  promise, then RE-FITS so the PTY cols/rows match the real metrics.
 *
 *  Warm path (faces already loaded, the norm thanks to the boot warm-up in
 *  main.tsx): return immediately, zero cost. The re-fit is guarded against
 *  zero-geometry hosts (collapsed split, same reason the panes' ResizeObservers
 *  bail at 0x0) and the mid-spawn window where term.onResize isn't registered
 *  yet, which would silently desync PTY cols/rows (hence the ptyResize retry). */
export async function awaitTerminalFonts(
  term: Terminal,
  fit: { fit(): void },
  host: HTMLElement,
  isCancelled: () => boolean,
  ptyId: () => string | null,
): Promise<void> {
  if (isTerminalFontReady()) return;
  await terminalFontReady;
  if (isCancelled()) return;
  // Faces are genuinely loaded now, so cols/rows measured against the fallback
  // are stale: re-fit. No clearTextureAtlas (the WebGL renderer only attached
  // once the faces were loaded, so the atlas was never poisoned).
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
  try { fit.fit(); } catch {}
  let tries = 20;
  const push = () => {
    if (isCancelled() || tries-- <= 0) return;
    const pid = ptyId();
    if (pid) ipc.ptyResize(pid, term.rows, term.cols).catch(() => {});
    else window.setTimeout(push, 250);
  };
  push();
}

/** Context-loss recovery budget. A dead GL context is normal and transient
 *  (WebKit reaps the GPU process under memory pressure, after sleep, or after
 *  a long idle); a GPU that dies MAX times inside WINDOW is not, and retrying
 *  into it just black-flashes the pane on a loop. Past the budget we stay on
 *  xterm's DOM renderer, which is slower but always paints, until the losses
 *  age out of the window and WebGL is worth a try again. Deliberately a
 *  sliding window rather than a permanent give-up: a terminal can live for
 *  days in one session, and a transient GPU outage should not cost it the
 *  fast renderer for all of them.
 *  The delay is one beat for WebKit's GPU process to come back:
 *  asking for a context in the same task as the loss event hands back one
 *  that is already lost. Exported for terminalRenderer.test.ts. */
export const CONTEXT_LOSS_WINDOW_MS = 60_000;
export const CONTEXT_LOSS_MAX = 3;
export const CONTEXT_REATTACH_DELAY_MS = 100;

export function loadTerminalRenderer(term: Terminal): { dispose(): void } {
  let addon: WebglAddon | CanvasAddon | null = null;
  let disposed = false;

  // Reported symptom: after a long session (sleep, or the window left in the
  // background for hours) every terminal pane is BLACK, and only restarting
  // that tab brings it back. Nothing is wrong with the terminal — the PTY is
  // live and the scrollback is intact, which is exactly why a respawn "fixes"
  // it. What died is the WebGL context: WKWebView reclaims GPU resources for
  // a webview it considers idle, every context in the process is lost at
  // once, and the addon's canvas keeps compositing its last (empty) frame.
  //
  // This handler used to be `a.onContextLoss(() => a.dispose())`. Disposing is
  // necessary (a renderer on a dead context draws nothing and throws on some
  // paths) but it is only half the job: xterm falls back to its DOM renderer
  // internally, yet nothing repaints, so the pane stays black until the user
  // notices and restarts the tab by hand. Do NOT reduce this back to a bare
  // dispose. Re-attaching is what gets the pixels back.
  let lossTimes: number[] = [];
  // The budget is a sliding window, not a one-way latch: losses that age out
  // stop counting, so a GPU that comes back an hour later gets WebGL back
  // instead of leaving the terminal on the DOM renderer for the rest of its
  // life. Every path that would attach WebGL has to consult this, not just the
  // loss handler, or the give-up decision is only as durable as the next
  // window focus.
  const lossBudgetSpent = () => {
    const now = Date.now();
    lossTimes = lossTimes.filter(t => now - t < CONTEXT_LOSS_WINDOW_MS);
    return lossTimes.length > CONTEXT_LOSS_MAX;
  };

  const recoverFromContextLoss = (lost: WebglAddon) => {
    try { lost.dispose(); } catch { /* already gone */ }
    if (addon === lost) addon = null;
    if (disposed) return;
    lossTimes.push(Date.now());
    if (lossBudgetSpent()) {
      // Out of budget: the DOM renderer xterm fell back to on dispose owns the
      // pane now, but it only paints rows it is told are dirty and the loss
      // dirtied nothing. Without this the give-up path looks identical to the
      // bug it exists to avoid.
      try { term.refresh(0, term.rows - 1); } catch { /* mid-teardown */ }
      return;
    }
    window.setTimeout(() => { if (!disposed && !addon) attach(); }, CONTEXT_REATTACH_DELAY_MS);
  };

  // The event is not guaranteed. A webview that is suspended (window hidden
  // for hours, App Nap) can have its context reaped without `webglcontextlost`
  // ever being delivered — the same black pane with no callback to recover
  // from it, which is the shape the original report describes. So also probe
  // on the edges where the user is about to LOOK at the terminal: focus and
  // visibilitychange. `_gl` is optional-chained and pinned by
  // xtermInternals.test.ts, so an xterm rename degrades to "event-driven
  // recovery only" rather than throwing.
  //
  // A null addon here is the other half: an earlier re-attach that ran while
  // the GPU was still down hit the catch in attach() and left the terminal on
  // the DOM renderer. Wake is the natural moment to try again.
  const onWake = () => {
    if (disposed || document.visibilityState === "hidden") return;
    if (addon instanceof WebglAddon) {
      const gl = (addon as unknown as { _renderer?: { _gl?: WebGLRenderingContext } })
        ._renderer?._gl;
      if (gl?.isContextLost() === true) recoverFromContextLoss(addon);
      return;
    }
    if (!addon && isTerminalFontReady() && !lossBudgetSpent()) attach();
  };
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);

  const attach = () => {
    const kind = usePrefs.getState().terminalRenderer;
    if (disposed || addon || kind === "dom") return;
    try {
      if (kind === "canvas") {
        // No GL context, so no onContextLoss and no shared texture atlas to
        // park: the canvas renderer owns its own <canvas> layers inside the
        // terminal element, and disposing it takes them with it. That is the
        // whole reason it exists as a middle option.
        const c = new CanvasAddon();
        term.loadAddon(c);
        addon = c;
        return;
      }
      const a = new WebglAddon();
      a.onContextLoss(() => recoverFromContextLoss(a));
      // Atlas swaps (font/theme/dpr). Microtask: the event fires before the
      // renderer stores the new atlas; its warm-up runs later, on idle.
      a.onChangeTextureAtlas(() => queueMicrotask(() => { if (!disposed) keepAtlasCanvasConnected(a); }));
      term.loadAddon(a);
      addon = a;
      // Initial atlas (born inside loadAddon; fires the event too early for
      // the addon to forward it). Park before the idle warm-up rasterizes.
      keepAtlasCanvasConnected(a);
    } catch {
      addon = null;  // renderer unsupported → xterm's DOM renderer remains
    }
  };

  // GH #70: hold the FIRST attach until the owned faces are genuinely loaded
  // (terminalFontReady is real FontFace handles, not document.fonts.check(),
  // which is vacuously true before the family is registered). The addon then
  // builds its glyph atlas against the real face instead of caching
  // fallback-height glyphs that never correct, so nothing is ever cleared under
  // a live renderer. xterm's DOM renderer covers the gap. GPU-off and warm-face
  // attach right away; a face that never loads still resolves terminalFontReady
  // and gets GPU (consistent fallback, not the mixed-height "waves").
  //
  // The canvas renderer keys its glyph cache the same way, so it needs the
  // same gate; only "dom" can attach unconditionally, and for it attach() is
  // a no-op anyway.
  if (isTerminalFontReady() || usePrefs.getState().terminalRenderer === "dom") {
    attach();
  } else {
    terminalFontReady.then(() => { if (!disposed && !addon) attach(); });
  }

  // TEMP diagnostic. Auto-dumps the launch state; the global lets the
  // user dump again after a monitor move (the crisp state) to diff.
  (window as unknown as { __termicDumpRenderer?: () => void }).__termicDumpRenderer =
    () => dumpRenderer(addon);
  const dumpTimers = [400, 1800].map(d => window.setTimeout(() => dumpRenderer(addon), d));

  return {
    dispose() {
      disposed = true;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      dumpTimers.forEach(t => window.clearTimeout(t));
      // Park the shared atlas canvas before this pane's DOM unmounts with it.
      // Only WebGL has one; the canvas renderer's layers die with its dispose.
      if (addon instanceof WebglAddon) keepAtlasCanvasConnected(addon, term.element);
      try { addon?.dispose(); } catch { /* already gone */ }
    },
  };
}
