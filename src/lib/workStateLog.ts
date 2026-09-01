// Always-on trace of every work-state decision, to a file.
//
// The spinner vanishing on a task that is still working is only diagnosable
// AFTER it happens, and the person it happens to is running a packaged build
// with no devtools, so `localStorage.debugWorkDone` (console) and
// `localStorage.ptyDebug` (file) are both out of reach. This needs no flag: by
// the time anyone notices the symptom the evidence has to already be on disk.
//
// Affordable because it is not the hot path. A transition is a handful of
// events per turn, not per frame: `setWorkState` bails on an unchanged value
// before it gets here, and the callers that fire on every PTY chunk are all
// re-asserting a state they already hold. The BAILS are logged too, and they
// are the interesting half: "working was requested and refused because the tab
// is inside its post-click grace window" is the answer to a missing spinner,
// and it is invisible in the resulting state.

import { ptyDebugAppend } from "@/lib/ipc";

/** One file, so a session's whole story is in time order across every task.
 *
 *  One file PER BUILD FLAVOUR, because they share an OS temp dir and get run at
 *  the same time: a suite run interleaved hundreds of fixture transitions into
 *  the file someone was reading to diagnose their real agents, and `make dev`
 *  alongside the installed beta would do the same with two live apps. Whoever
 *  reads a tail should not have to work out which app wrote which line. Found
 *  while hand-filtering exactly that. */
export const WORK_STATE_LOG =
  import.meta.env.VITE_E2E ? "termic-workstate-e2e.log"
  : import.meta.env.DEV ? "termic-workstate-dev.log"
  : "termic-workstate.log";

// A session cannot fill the disk. Transitions are rare, so this is generous for
// a long day and still bounded; the cap is announced in the log rather than
// leaving a reader to wonder why the tail stops mid-session.
const MAX_LINES = 20_000;
let written = 0;

/** Fire and forget. Never throws, never blocks a state transition: a
 *  diagnostic that can break the thing it observes is worse than none. */
export function logWorkState(event: string, detail: string): void {
  // `>=`, not `>`: with `>` the counter reached the cap, emitted the notice,
  // and then wrote one more ordinary line after it, so the log ended by
  // contradicting itself about where it stopped.
  if (written >= MAX_LINES) return;
  written += 1;
  const line = written === MAX_LINES
    ? `${new Date().toISOString()} log-capped   reached ${MAX_LINES} lines, stopping`
    : `${new Date().toISOString()} ${event.padEnd(12)} ${detail}`;
  try {
    void ptyDebugAppend(WORK_STATE_LOG, line).catch(() => {});
  } catch {
    // Pre-IPC (tests, SSR-ish contexts). Silence is correct here.
  }
}

/** Reset the session cap. Tests only. */
export function __resetWorkStateLog(): void {
  written = 0;
}
