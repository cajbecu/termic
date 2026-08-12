// Process-level memory sampling for the nightly perf run.
//
// Runs in the wdio WORKER (a Node process), not in the webview, because the
// numbers we want are OS-level and WKWebView exposes nothing equivalent
// (`performance.memory` is Chrome-only, and it would miss the helper processes
// where most of the cost lives anyway).
//
// ATTRIBUTION CAVEAT, inherited from the GH #140 harness: WebKit's XPC helpers
// are parented to launchd, not to the app, so ppid cannot attribute them. On a
// CI runner there is exactly one app and its helper set, so summing every
// WebKit helper is correct there. On a developer machine with Safari open it
// is NOT. `helperCount` is recorded alongside the total so an implausible
// number is visible rather than silently folded into the series.

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

/** The app binary the perf run launched. Debug build, driven by wdio. */
export function findAppPid(): number | null {
  const pids = pidsMatching("src-tauri/target/debug/termic");
  return pids.length ? pids[0] : null;
}

export function sampleRss(appPid: number | null): RssSnapshot {
  const appMiB = appPid === null ? null : rssMiB(appPid);

  const helperPids = pidsMatching("com.apple.WebKit");
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
