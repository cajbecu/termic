// Pushes the list of tasks needing attention (blocked on the user) or done
// (finished a turn) down to the tray icon (src-tauri/src/lib.rs, build_tray /
// tray_set_attention), which rebuilds its dropdown + numeral badge from it.
//
// No new attention logic here: computeAgentStates() (cliAgentState.ts)
// already classifies every live task working > waiting > done > idle >
// inactive, mirroring the sidebar's own aggregate. Only "waiting" and "done"
// are relevant to the tray.
//
// Push discipline mirrors initAgentStatePush (cliAgentState.ts): debounced on
// a store subscription, diffed against the last-sent payload so an unchanged
// tick doesn't rebuild the native menu. Unlike that cache, this isn't
// staleness-gated, so there's no periodic heartbeat re-push.

import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/store/app";
import { computeAgentStates } from "@/lib/cliAgentState";

export interface TrayAttentionItem {
  task_id: string;
  task_name: string;
  project_name: string;
  /** "waiting" (blocked on the user) or "done" (finished a turn). */
  state: "waiting" | "done";
}

/** Sorted by project name, then attention-before-done, then task name — Rust
 *  trusts this order for its section-header grouping rather than re-sorting. */
export function computeTrayAttention(s = useApp.getState()): TrayAttentionItem[] {
  const states = computeAgentStates(s);
  const items: TrayAttentionItem[] = [];
  for (const task of s.tasks) {
    if (task.archived) continue;
    const st = states[task.id]?.state;
    if (st !== "waiting" && st !== "done") continue;
    const project = s.projects.find(p => p.id === task.project_id);
    if (!project) continue;
    items.push({
      task_id: task.id,
      task_name: task.name,
      project_name: project.name,
      state: st,
    });
  }
  items.sort((a, b) =>
    a.project_name.localeCompare(b.project_name)
    || (a.state === b.state ? 0 : a.state === "waiting" ? -1 : 1)
    || a.task_name.localeCompare(b.task_name));
  return items;
}

/** Trailing-edge debounce: the store changes on every PTY output chunk, so
 *  the tray push is recomputed at most once per this window. */
const PUSH_DEBOUNCE_MS = 150;

let started = false;

/** Start pushing the attention list to the tray. Idempotent; returns a stop
 *  function that clears the latch so a remount re-registers. */
export function initTrayAttention(): () => void {
  if (started) return () => {};
  started = true;
  let lastSent = "";
  let timer: number | undefined;

  const push = () => {
    const items = computeTrayAttention();
    const body = JSON.stringify(items);
    if (body === lastSent) return;
    lastSent = body;
    invoke("tray_set_attention", { items }).catch(() => {
      lastSent = "";
    });
  };
  const schedule = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      push();
    }, PUSH_DEBOUNCE_MS);
  };

  const unsub = useApp.subscribe(schedule);
  // The row-icon colors are picked in Rust (menu_bar_is_dark) at push time,
  // not template-recolored by macOS. Without this, toggling the system
  // appearance while the attention list happens not to change leaves the
  // dark-menu-bar color stranded on a now-light menu bar (and vice versa)
  // until something else changes the list. Force a re-push on the edge —
  // the browser's own read of the same OS-level appearance signal Rust
  // will re-sample when it rebuilds the icon.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onAppearanceChange = () => {
    lastSent = "";
    schedule();
  };
  media.addEventListener("change", onAppearanceChange);
  push();

  return () => {
    started = false;
    unsub();
    media.removeEventListener("change", onAppearanceChange);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
