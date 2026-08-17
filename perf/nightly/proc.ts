// Process-level memory sampling for the nightly perf run.
//
// Runs in the wdio WORKER (a Node process), not in the webview, because the
// numbers we want are OS-level and WKWebView exposes nothing equivalent
// (`performance.memory` is Chrome-only, and it would miss the helper processes
// where most of the cost lives anyway).
//
// ATTRIBUTION, inherited from the GH #140 harness: WebKit's XPC helpers are
// parented to launchd, not to the app, so ppid cannot attribute them. They are
// spawned moments after their host, so the host's helper is the lowest pid
// above the host's, taken per helper type. `helperCount` is recorded alongside
// the total so a wrong attribution is visible rather than silently folded into
// the series: it should be 3 (GPU, Networking, WebContent).

import { execFileSync } from "node:child_process";

export interface RssSnapshot {
  /** The Tauri/Rust process. */
  appMiB: number | null;
  /** Sum of WebKit helper processes (WebContent, GPU, Networking). */
  helpersMiB: number | null;
  /** How many helpers were summed. Sanity check on the attribution above. */
  helperCount: number;
  /** appMiB + helpersMiB, the number that actually reflects user-visible cost. */
  totalMiB: number | null;
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** RSS in MiB for one pid, via `ps` (macOS reports KiB). */
function rssMiB(pid: number): number | null {
  const out = sh("ps", ["-o", "rss=", "-p", String(pid)]).trim();
  if (!out) return null;
  const kib = Number.parseInt(out, 10);
  return Number.isFinite(kib) ? Math.round((kib / 1024) * 10) / 10 : null;
}

function pidsMatching(pattern: string): number[] {
  const out = sh("pgrep", ["-f", pattern]).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map(l => Number.parseInt(l.trim(), 10))
    .filter(n => Number.isFinite(n) && n !== process.pid);
}

/** The app binary the perf run launched. Debug build, driven by wdio.
 *
 *  Anchored with `$`, matching perf/local/measure.sh. This is DEFENSIVE, not a fix
 *  for an observed bug: measured on a real run, the unanchored pattern also
 *  matched exactly one process, so nothing was being misattributed. The anchor
 *  guards against a future caller whose argv happens to contain the same path
 *  (a wrapper script, a profiler) silently becoming "the app".
 *
 *  Note for whoever reads a number from this: ~1.6 GiB RSS for the debug build
 *  is real and reproducible, not a measurement artefact. Debug binaries carry
 *  debuginfo and RSS counts mapped file pages. Do not compare it to a release
 *  build's footprint. */
export function findAppPid(): number | null {
  const pids = pidsMatching("src-tauri/target/debug/termic$");
  return pids.length ? Math.min(...pids) : null;
}

/** WebKit spawns one helper of each type moments after its host, so the host's
 *  helper is the LOWEST pid above the host's, per type. Summing every
 *  `com.apple.WebKit` process instead is wrong on any machine with a second
 *  WebKit app running: measured here, that pulled in 10 helpers across three
 *  unrelated apps and added ~570 MiB of somebody else's memory to the total.
 *  Attribution by ppid is not available (they are all parented to launchd). */
const HELPER_TYPES = ["com.apple.WebKit.GPU", "com.apple.WebKit.Networking", "com.apple.WebKit.WebContent"];

function helperPidsFor(appPid: number): number[] {
  const found: number[] = [];
  for (const type of HELPER_TYPES) {
    const above = pidsMatching(type).filter(p => p > appPid).sort((a, b) => a - b);
    if (above.length) found.push(above[0]);
  }
  return found;
}

/** Least-squares slope of `ys` against its own index, plus how much of the
 *  variance that line explains.
 *
 *  This is what "is it leaking" actually asks. A difference between two
 *  snapshots answers it only if both were taken on a flat stretch; a slope over
 *  many samples answers it even when the ends are imperfect, and `r2` says
 *  whether the slope is a trend or a line drawn through noise.
 *
 *  Exported and pure so it is unit-tested (`proc.test.ts`) rather than trusted:
 *  a metric nobody can test is a metric nobody should read. */
export function trend(ys: number[]): { slope: number; r2: number; n: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, r2: 0, n };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (ys[i] - meanY);
    sxx += (i - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  // r² against the fitted line. A flat series (every sample identical) has no
  // variance to explain, and calling that a perfect fit would dress up "the
  // number never moved" as a confident trend, so it reports 0.
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fit = meanY + slope * (i - meanX);
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - fit) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2, n };
}

/** True when a window of samples is flat rather than merely narrow.
 *
 *  The spread test this replaces (`max - min <= tol`) cannot tell a monotonic
 *  DRIFT from jitter: four samples falling 2 MiB each sit inside an 8 MiB
 *  spread while shedding ~120 MiB/minute. That is how the first CI run
 *  "settled" its baseline 8s in, mid startup-decay, and reported growth of
 *  -88.8 MiB across the cycles. So both have to hold: the window must be
 *  narrow AND its net drift end-to-end must be small. */
export function isFlat(window: number[], tolMiB: number): boolean {
  if (window.length < 2) return false;
  const spread = Math.max(...window) - Math.min(...window);
  const netDrift = Math.abs(window[window.length - 1] - window[0]);
  return spread <= tolMiB && netDrift <= tolMiB / 2;
}

/** Poll until RSS stops moving, then return the settled snapshot.
 *
 *  A fixed sleep does NOT work here, and the first version of this suite proved
 *  it: a 5s pause caught the startup peak, RSS then decayed for another half
 *  minute, and "growth across 12 cycles" came out at -355 MiB. A negative leak
 *  number is a nonsense metric, and it was measuring startup decay rather than
 *  anything the cycles did. This is GH #140 trap 6 ("poll until quiet instead")
 *  in a different costume, documented in perf/local/README.md.
 *
 *  Settled = a `streak`-long window that `isFlat` accepts. `maxMs` is generous
 *  on purpose: the decay this exists to outlast ran for half a minute on one
 *  machine, and giving up early returns `settled: false` for the caller to
 *  label, which is honest but useless. */
export async function waitForStableRss(
  appPid: number | null,
  { tolMiB = 8, streak = 6, intervalMs = 1_000, maxMs = 90_000 } = {},
): Promise<{ snapshot: RssSnapshot; settled: boolean; waitedMs: number }> {
  const started = Date.now();
  const recent: number[] = [];
  let last = sampleRss(appPid);

  while (Date.now() - started < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    last = sampleRss(appPid);
    const total = last.totalMiB;
    if (total === null) continue;

    recent.push(total);
    if (recent.length > streak) recent.shift();
    if (recent.length === streak && isFlat(recent, tolMiB)) {
      return { snapshot: last, settled: true, waitedMs: Date.now() - started };
    }
  }
  return { snapshot: last, settled: false, waitedMs: Date.now() - started };
}

export function sampleRss(appPid: number | null): RssSnapshot {
  const appMiB = appPid === null ? null : rssMiB(appPid);

  const helperPids = appPid === null ? [] : helperPidsFor(appPid);
  let helpersMiB: number | null = null;
  for (const pid of helperPids) {
    const m = rssMiB(pid);
    if (m !== null) helpersMiB = (helpersMiB ?? 0) + m;
  }
  if (helpersMiB !== null) helpersMiB = Math.round(helpersMiB * 10) / 10;

  const totalMiB =
    appMiB === null && helpersMiB === null
      ? null
      : Math.round(((appMiB ?? 0) + (helpersMiB ?? 0)) * 10) / 10;

  return { appMiB, helpersMiB, helperCount: helperPids.length, totalMiB };
}
