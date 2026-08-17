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

/** Poll until RSS stops moving, then return the settled snapshot.
 *
 *  A fixed sleep does NOT work here, and the first version of this suite proved
 *  it: a 5s pause caught the startup peak, RSS then decayed for another half
 *  minute, and "growth across 12 cycles" came out at -355 MiB. A negative leak
 *  number is a nonsense metric, and it was measuring startup decay rather than
 *  anything the cycles did. This is GH #140 trap 6 ("poll until quiet instead")
 *  in a different costume, documented in perf/local/README.md.
 *
 *  Settled = `streak` consecutive samples within `tolMiB` of each other. Gives
 *  up after `maxMs` and returns the last sample, with `settled: false` so the
 *  caller can label the row rather than silently reporting a peak. */
export async function waitForStableRss(
  appPid: number | null,
  { tolMiB = 8, streak = 4, intervalMs = 1_000, maxMs = 45_000 } = {},
): Promise<{ snapshot: RssSnapshot; settled: boolean; waitedMs: number }> {
  const started = Date.now();
  let recent: number[] = [];
  let last = sampleRss(appPid);

  while (Date.now() - started < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    last = sampleRss(appPid);
    const total = last.totalMiB;
    if (total === null) continue;

    recent.push(total);
    if (recent.length > streak) recent.shift();
    if (recent.length === streak && Math.max(...recent) - Math.min(...recent) <= tolMiB) {
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
