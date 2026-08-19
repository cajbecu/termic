// Bridges the CURRENTLY DISPLAYED tab title from the main window to the
// separate Activity window. Activity runs in its own webview (Tauri window,
// `?window=procmon`), so it cannot read the main window's Zustand state —
// `liveTitle` (the agent's live OSC title) lives only in the main window's
// JS memory and is never persisted to disk (see ActivityWindow.tsx's
// sampling-discipline comment). Pull-based, matching the rest of Activity's
// architecture ("no Rust sampler thread, the window's own interval is the
// clock"): the main window answers only when asked, so this costs nothing
// while Activity is closed.

import { emit, listen } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import { logLine } from "@/lib/ipc";
import type { TerminalTab } from "@/lib/types";

const REQUEST = "activity://request-titles";
const REPLY = "activity://titles";

// `emit`/`listen` are the core `event` plugin, which — unlike a plain
// `#[tauri::command]` — IS capability-gated per window (see
// src-tauri/capabilities/procmon.json). A future capability regression
// (window renamed, file deleted, permission dropped) would otherwise fail
// SILENTLY: the promise rejects, nothing throws past `void`, and the only
// visible symptom is titles quietly reverting to the "Tab N" fallback. Log
// once per failure via `log_line` (a plain command, not gated) so a broken
// bridge shows up in the debug log instead of looking like a UI bug.
function logBridgeError(where: string, e: unknown) {
  const msg = `[activityTitleBridge] ${where} failed: ${String(e)}`;
  // eslint-disable-next-line no-console
  console.error(msg);
  void logLine(msg).catch(() => {});
}

/** Main-window side. Call once (e.g. from App.tsx) — answers every request
 *  with `{ titles: Record<tabId, string> }`, the same effective title text
 *  TabBar.tsx renders (`tab.customTitle ? tab.title : (tab.liveTitle || tab.title)`),
 *  for every live terminal tab across every task. */
export function initActivityTitleBridge(): () => void {
  const unlistenPromise = listen(REQUEST, () => {
    const titles: Record<string, string> = {};
    for (const tabs of Object.values(useApp.getState().tabs)) {
      for (const tab of tabs) {
        if (tab.type !== "terminal") continue;
        const t = tab as TerminalTab;
        const raw = t.customTitle ? t.title : (t.liveTitle || t.title);
        if (raw) titles[t.id] = raw;
      }
    }
    emit(REPLY, { titles }).catch(e => logBridgeError("main window: emit(titles reply)", e));
  }).catch(e => { logBridgeError("main window: listen(request)", e); return () => {}; });
  return () => { void unlistenPromise.then(u => u()); };
}

/** Activity-window side. Subscribes to replies (updating `onTitles` whenever
 *  one arrives) and returns a `request()` function the caller fires on its
 *  own sampling cadence — same shape as `loadMeta` re-reading the project/
 *  task lists. Returns the unlisten/cleanup function. */
export function subscribeActivityTitles(
  onTitles: (titles: Record<string, string>) => void,
): { request: () => void; stop: () => void } {
  const unlistenPromise = listen<{ titles: Record<string, string> }>(REPLY, ev => onTitles(ev.payload.titles))
    .catch(e => { logBridgeError("activity window: listen(reply)", e); return () => {}; });
  return {
    request: () => { emit(REQUEST).catch(e => logBridgeError("activity window: emit(request)", e)); },
    stop: () => { void unlistenPromise.then(u => u()); },
  };
}
