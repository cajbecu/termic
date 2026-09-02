// Looking at a tab for a moment counts as having seen its badge.
//
// `markAttention` marks unconditionally, focused tab included, and the badge
// then cleared only on a keystroke in that terminal or on activating the task
// again. So the common case left it stuck: the tab you are already on earns a
// badge while you are in another app, you come back, and because the tab never
// CHANGED nothing cleared it. Clicking away and back was the only way out,
// which is a strange thing to have to do to a badge that exists to tell you
// about the pane filling your screen.
//
// The rule was borrowed from iTerm2, where a bell marks a tab you may not be
// looking at. Termic puts the same mark on the tab that IS in front of you,
// where it answers a question nobody asked.
//
// Presence is the window being focused, not merely open. `isUserWatching` only
// excludes the windowless case (closed to the menu bar), so a Termic sitting
// behind someone's browser still counts as watched there. That is right for
// deciding whether to BADGE (you were away, you should be told) and wrong for
// deciding whether you have SEEN it, which is what this asks.

import { useEffect } from "react";
import { isTabOnScreenIn, useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { AppState } from "@/store/app";

/** How long the tab has to be the one on screen, in a focused window, before
 *  its badge is treated as read.
 *
 *  Not instant, deliberately. Focusing the window is not the same as reading
 *  the pane: a cmd-Tab through Termic on the way somewhere else would silently
 *  eat a badge that was never seen, and a badge destroyed is worse than a badge
 *  held a second too long. Three seconds is long enough that the user is
 *  actually present and short enough that nobody reaches for the mouse first. */
export const SEEN_DWELL_MS = 3_000;

/** The badged tab that is on screen, as a stable string key
 *  (`taskId:tabId`) or "" for none. A primitive so the Zustand selector cannot
 *  churn: returning an object here would re-run every subscriber on each store
 *  write, which is the fanout trap this codebase measures for. */
export function dwellTarget(s: AppState): string {
  const taskId = s.activeTaskId;
  if (!taskId) return "";
  const tabs = s.tabs[taskId] || [];
  // `unread` OR a done work state: they are separate fields feeding separate
  // badges, and a tab can hold either without the other (a keystroke clears
  // unread and leaves the dot).
  const t = tabs.find(t =>
    (t.unread || (t.type === "terminal" && t.workState === "done"))
    && isTabOnScreenIn(s, taskId, t.id));
  return t ? `${taskId}:${t.id}` : "";
}

export function useSeenOnDwell() {
  const target = useApp(dwellTarget);
  // One source of truth, shared with `isUserWatchingIn`. A second copy of
  // "is the window focused" in this hook would drift from the one that decides
  // whether a badge is created at all, and the two disagreeing is precisely
  // how a badge gets created and instantly cleared.
  // Read SEPARATELY from the app-store target, not folded into it: a selector
  // over `useApp` does not re-run when `useUI` changes, so a target that
  // baked in focus would still say "nobody is looking" after the user came
  // back, and the badge would never clear.
  const present = useUI(s => s.windowFocused && !s.windowless);

  useEffect(() => {
    if (!target || !present) return;
    const [taskId, tabId] = target.split(":");
    const id = window.setTimeout(() => {
      // Re-check rather than trusting the closure. The dwell is three seconds
      // of real time and anything can happen inside it; clearing a badge that
      // has since moved to another tab would destroy the one signal this
      // feature is meant to respect.
      if (dwellTarget(useApp.getState()) !== target) return;
      const app = useApp.getState();
      // BOTH, because the two badges have different sources and clearing one
      // leaves the other on screen. The bell reads `unread.reason`, the blue
      // done dot reads `workState === "done"` (Sidebar's hasAttention vs
      // hasDone, and TabBar's showBell vs showDone). The first version called
      // `clearAttention` alone, so a finished agent kept its dot after the user
      // came back and only `setActiveTask`, the one path that also writes the
      // work state, could shift it. Reported as "the only way is to click the
      // item in the sidebar", which is precisely that path.
      app.clearAttention(taskId, tabId);
      const tab = (app.tabs[taskId] ?? []).find(t => t.id === tabId);
      if (tab?.type === "terminal" && tab.workState === "done") {
        app.setWorkState(taskId, tabId, "idle", "seen: watched for the dwell");
      }
    }, SEEN_DWELL_MS);
    // Cancels on blur, on the badge going away, and on the user switching to a
    // different tab, because each of those changes a dep.
    return () => window.clearTimeout(id);
  }, [target, present]);
}
