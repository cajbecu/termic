# bench/ — local performance harness

**Local only. Never in CI, and not because it is slow.** These scripts measure
CPU, GPU and compositor cost, which cannot be measured on a virtualised
GitHub runner without producing confidently wrong numbers. The reasoning, and
what *can* be gated in CI instead, is in
[docs/research/perf-ci.md](../docs/research/perf-ci.md).

This harness was built for GH #140 and it earned its keep: it refuted a claim
that had already shipped into the 0.26.0 changelog. It lived in the gitignored
`scratchpad/` until then, which is why it is tracked now. The scripts are
worth less than the traps encoded in them.

## Scripts

| Script | What it does |
|---|---|
| `measure.sh <label> <seconds>` | One sample. WindowServer / WebContent / WebKit.GPU / app CPU as cputime deltas, plus averaged GPU device utilisation. |
| `setrenderer.sh <webgl\|canvas\|dom>` | Point the app at one xterm renderer. Refuses to run while the app is up. |
| `run-three.sh [reps] [measure-seconds]` | Full A/B/C: three renderers, interleaved reps, median with min/max. |

Environment: `TERMIC_APP` (default `Termic Beta`), and `TERMIC_BENCH_W` /
`TERMIC_BENCH_H` for the window size in `run-three.sh`.

```sh
TERMIC_APP="Termic Beta" ./bench/run-three.sh 5 20
```

## Read this before trusting a number

Each of the following invalidated a full run during GH #140. All of them
produce a *plausible wrong number* rather than an error, which is the whole
problem.

1. **Locale.** A comma-decimal locale makes `awk` parse `159639,08` as
   `159639`, so every sub-second cputime delta rounds to 0. Every script pins
   `LC_ALL=C`. Do not remove it.
2. **Occlusion, not focus.** WKWebView throttles when its window is occluded,
   which collapses WindowServer, WebContent, WebKit.GPU and GPU *at the same
   time* and reads as "the GL surface is free". Every sample is bracketed by a
   frontmost check; `front=LOST[...]` means **discard the sample**, it does not
   mean zero cost.
3. **Canvas pixel count dominates.** A 1500x1000 window at DPR 1 is a ~0.8M
   pixel terminal canvas; a Retina laptop is ~3.2M. Numbers are not comparable
   across machines until the pixel counts are. Maximise first.
4. **Cursor blink.** `cursorBlink: true` is hardcoded
   (`TerminalPane.tsx`, `AuxTerminal.tsx`), so a *focused* terminal is never
   idle. The DOM arm measured 4.0% focused vs 0.1% blurred, a 40x swing. Decide
   deliberately which one you are measuring.
5. **`WebKit.GPU` is not a WebGL indicator.** It is WebKit's GPU process for
   all compositing and is busy under the DOM renderer too.
6. **Startup noise.** Measuring inside a fixed sleep after launch caught
   WebContent at 12%. Poll until quiet instead (`wait_quiet` in
   `run-three.sh`).
7. **Ambient input.** The user typing anywhere, including in another app,
   breaks a run. `run-three.sh` holds `caffeinate` and aborts if the screen
   locks. Leave the machine alone.

## The GH #140 result, for reference

GH #140 (closed, PR #167) claimed the WebGL renderer costs ~33pp of
WindowServer CPU and ~44pp of GPU while idle. On an M1 Max / macOS 26.5.2 /
3840x1600 DPR-1 panel that magnitude **did not reproduce**: the WebGL delta
measured ~1.4-2.5pp of WindowServer.

Four independent runs, consistent: DOM `webcontent` 4.0-4.5 / `webkitgpu` 1.8;
WebGL `webcontent` 2.6-2.7 / `webkitgpu` 0.6. WebGL is *cheaper* app-side; only
WindowServer is slightly higher. The renderer toggle is justified as a
compatibility escape hatch, not a battery win.
