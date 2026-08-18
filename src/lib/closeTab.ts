// Tab-close with an unsaved-changes guard.
//
// EVERY close path — the main strip's "×", a pane pill's "×", and ⌘W in
// either pane — routes through here so a dirty editor buffer or a live agent
// session can never be discarded without the user explicitly confirming.
// termic never auto-saves, so closing a dirty `edit` tab is genuinely
// destructive.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import type { Tab } from "@/lib/types";
import { agentDisplayName, isTerminalCli } from "@/lib/agents";

/** Shared confirm gate: resolves true when closing `tab` is safe (nothing to
 *  lose, or the user confirmed). `paneTab` tweaks the agent copy — pane tabs
 *  are never durable, so closing an agent there always forgets the session. */
async function confirmTabClose(tab: Tab | undefined, paneTab: boolean): Promise<boolean> {
  if (tab?.type === "edit" && tab.dirty) {
    const name = tab.path.split("/").pop() || tab.path;
    // No checkbox in the request → askConfirm resolves a plain boolean; the
    // === true keeps TS happy across its overloads.
    const ok = await useUI.getState().askConfirm({
      title: "Close without saving?",
      message: `"${name}" has unsaved changes. Closing the tab will discard them. ⌘S to save first.`,
      confirmLabel: "Discard & close",
      destructive: true,
    });
    return ok === true;
  }
  // Agent-tab close semantics (issue #23): the MAIN agent tab stays durable
  // — closing it just ends the process and the session auto-resumes when the
  // task wakes, so it's not destructive. A SECONDARY ("+") agent tab or
  // a split-pane agent tab is FORGOTTEN on close — X is the way to get rid
  // of it for good — so that close is destructive and the copy says so.
  // Plain shells (cli === "shell") close instantly; there's nothing to lose.
  if (tab?.type === "terminal" && tab.cli !== "shell") {
    // Custom-command and registry-terminal tabs have no agent session to
    // end or resume — the confirm is only about killing the live process.
    const termLike = isTerminalCli(tab.cli, useApp.getState().agents);
    // Process already exited (ptyId cleared on exit) → nothing to stop, and
    // terminal-like tabs have no session to lose either. Close silently
    // instead of a fake "Stops the running process" confirm.
    if (termLike && !tab.ptyId) return true;
    // Fast path: the user opted out by unticking "Show this every time" in
    // the dialog below. The "+" menu's Resume section (backed by closedTabs)
    // makes undoing a close one click away, so a blocking modal on every
    // close is no longer the only safety net. requestCloseTab /
    // requestClosePaneTab toast a Resume shortcut once the close lands.
    if (!usePrefs.getState().confirmBeforeCloseAgentTab) return true;
    const label = tab.cli === "custom"
      ? (tab.title || "this command")
      : agentDisplayName(tab.cli, useApp.getState().agents);
    const isMain = !paneTab && !!tab.is_default;
    // Only a PANE tab close is genuinely one-way: pane tabs are never
    // snapshotted into closedTabs (see app.ts's closeTab), so there is no
    // Resume entry to click afterwards. The main tab auto-resumes and a
    // secondary strip tab is one click away in the "+" menu, so neither
    // gets the red button or copy that implies loss (issue #102).
    const gone = !isMain && !termLike && paneTab;
    const ok = await useUI.getState().askConfirm({
      title: `Close ${label}?`,
      message: termLike
        ? "Stops the running process and closes the tab."
        : isMain
          ? "Stops the running process. The session resumes when you reopen the task."
          : gone
            ? "Ends this agent's session. A pane tab isn't kept, so this one can't be resumed."
            : "Ends this agent's session. Bring it back any time from the Resume list in the + menu.",
      confirmLabel: "Close tab",
      destructive: gone,
      dontAskAgain: true,
    });
    // Only persist the opt-out when the user actually confirmed the close —
    // unticking the box then backing out (Escape / Cancel / click-outside)
    // still resolves with dontAskAgain=true (ConfirmDialog reports whatever
    // the checkbox state was at dismissal), so gating on confirmed too
    // stops a cancelled close from silently disabling future confirmations.
    if (ok.confirmed && ok.dontAskAgain) usePrefs.getState().setConfirmBeforeCloseAgentTab(false);
    return ok.confirmed;
  }
  return true;
}

/** One confirm for a whole set (the context menu's "Close others" / "Close to
 *  the right"). A per-tab confirm would stack five modals on one gesture, so
 *  this dialog counts the losses and asks once. */
async function confirmBulkClose(tabs: Tab[]): Promise<boolean> {
  const agents = useApp.getState().agents;
  const dirty = tabs.filter(t => t.type === "edit" && t.dirty);
  // Same rule as confirmTabClose: an already-exited terminal-like tab has
  // neither a process to stop nor a session to lose.
  const live = tabs.filter(t =>
    t.type === "terminal" && t.cli !== "shell"
    && !(isTerminalCli(t.cli, agents) && !t.ptyId));
  if (!dirty.length && (!live.length || !usePrefs.getState().confirmBeforeCloseAgentTab)) return true;
  const parts: string[] = [];
  if (dirty.length) {
    parts.push(`termic discards the unsaved changes in ${dirty.length} ${dirty.length === 1 ? "file" : "files"}.`);
  }
  if (live.length) {
    parts.push(`termic ends ${live.length} agent ${live.length === 1 ? "session" : "sessions"}.`);
  }
  const ok = await useUI.getState().askConfirm({
    title: `Close ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}?`,
    message: parts.join(" "),
    confirmLabel: "Close tabs",
    destructive: true,
  });
  return ok === true;
}

/** After a fast-path close (confirm skipped, see above), tell the user
 *  where the tab went. Secondary tabs snapshot into `closedTabs` on close
 *  (see app.ts's closeTab) so the toast's action can reopen the exact one
 *  that was just closed; the main tab already auto-resumes on its own, so
 *  it gets an explanatory toast with no action. No-op for shells (closed
 *  silently, nothing to report) and edit tabs (own confirm path, unrelated
 *  to this pref). */
function toastClosedTab(taskId: string, tab: Tab, paneTab: boolean) {
  if (tab.type !== "terminal" || tab.cli === "shell") return;
  const label = tab.cli === "custom"
    ? (tab.title || "this command")
    : agentDisplayName(tab.cli, useApp.getState().agents);
  // Pane tabs are never snapshotted into closedTabs (see app.ts's closeTab) —
  // there's nothing to point the user back to, so just confirm the close.
  if (paneTab) {
    useUI.getState().pushToast(`Closed "${label}".`, "info");
    return;
  }
  const resumable = !tab.is_default;
  if (!resumable) {
    useUI.getState().pushToast(`Closed "${label}". It resumes automatically when you reopen this task.`, "info");
    return;
  }
  // Bind THIS close's entry now (toastClosedTab runs synchronously right
  // after closeTab, so closedTabs[taskId][0] is guaranteed to be it) rather
  // than re-deriving "the latest entry" at click time — otherwise a second
  // close (or a menu Resume) within the toast's ttl would make this button
  // reopen the wrong tab. resumeClosedTab no-ops if the id is already gone.
  const entryId = useApp.getState().closedTabs[taskId]?.[0]?.id;
  useUI.getState().pushToast(`Closed "${label}". Resume it from the + menu.`, "info", {
    ttlMs: 6000,
    action: {
      label: "Resume",
      onClick: () => { if (entryId) useApp.getState().resumeClosedTab(taskId, entryId); },
    },
  });
}

/** Close a main-pane tab, asking first when closing is destructive.
 *  Resolves once the tab is closed or the user backs out. */
export async function requestCloseTab(taskId: string, tabId: string) {
  const tab = useApp.getState().tabs[taskId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(tab, false))) return;
  const fastClose = tab?.type === "terminal" && tab.cli !== "shell" && !usePrefs.getState().confirmBeforeCloseAgentTab;
  useApp.getState().closeTab(taskId, tabId);
  if (fastClose && tab) toastClosedTab(taskId, tab, false);
}

/** Close a split-pane tab with the same confirm gate as the main path.
 *  Returns true when the tab was actually closed (so callers can chain a
 *  closePane when it was the pane's last tab), false when the user backed
 *  out. */
export async function requestClosePaneTab(taskId: string, paneId: string, tabId: string): Promise<boolean> {
  const tab = useApp.getState().tabs[taskId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(tab, true))) return false;
  const fastClose = tab?.type === "terminal" && tab.cli !== "shell" && !usePrefs.getState().confirmBeforeCloseAgentTab;
  useApp.getState().closePaneTab(taskId, paneId, tabId);
  if (fastClose && tab) toastClosedTab(taskId, tab, true);
  return true;
}

/** Close a set of main-pane tabs behind ONE confirm. Secondary agent tabs still
 *  snapshot into `closedTabs`, so the "+" menu's Resume section can bring any of
 *  them back. */
export async function requestCloseTabs(taskId: string, tabIds: string[]) {
  const tabs = (useApp.getState().tabs[taskId] ?? []).filter(t => tabIds.includes(t.id));
  if (!tabs.length) return;
  if (!(await confirmBulkClose(tabs))) return;
  for (const t of tabs) useApp.getState().closeTab(taskId, t.id);
}

/** Close a set of split-pane tabs behind ONE confirm. The clicked tab always
 *  survives both menu actions, so the pane can never end up empty here. */
export async function requestClosePaneTabs(taskId: string, paneId: string, tabIds: string[]) {
  const tabs = (useApp.getState().tabs[taskId] ?? []).filter(t => tabIds.includes(t.id));
  if (!tabs.length) return;
  if (!(await confirmBulkClose(tabs))) return;
  for (const t of tabs) useApp.getState().closePaneTab(taskId, paneId, t.id);
}
