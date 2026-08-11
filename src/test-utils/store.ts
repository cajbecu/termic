// Test-only interactor for the app store.
//
// Unit tests kept reaching all the way in — `useApp.getState().tabs[taskId]
// .find(t => t.id === tab.id) as TerminalTab` on every assertion. That spells
// out the store's SHAPE (tabs is a task-keyed record of arrays; a tab is found
// by id; terminal fields need a cast) in hundreds of places, so reshaping the
// store means editing hundreds of tests that were never about its shape.
//
// These helpers state the intent instead — "what work state is that tab in?" —
// and are the only place that knows how to get there. They are also the place
// to fix when the shape changes.
//
// NOT loaded by the app: nothing under src/test-utils is imported by src/main
// or any component, so it is never part of a build. Keep it that way.

import { useApp } from "@/store/app";
import type { QueueItem, Tab, Task, TerminalTab } from "@/lib/types";

/** The runtime work state of an agent tab. */
export type WorkState = NonNullable<TerminalTab["workState"]>;
/** The attention/done badge payload on a tab. */
export type Unread = NonNullable<TerminalTab["unread"]>;

// ── reads ─────────────────────────────────────────────────────────────

/** Every tab in a task, in order. Empty when the task has none. */
export function getTabs(taskId: string): Tab[] {
  return useApp.getState().tabs[taskId] ?? [];
}

/** Tab ids in order — for asserting ordering without leaking tab shape. */
export function getTabIds(taskId: string): string[] {
  return getTabs(taskId).map(t => t.id);
}

/** How many tabs the task has. */
export function getTabCount(taskId: string): number {
  return getTabs(taskId).length;
}

/**
 * The task's tab array BY REFERENCE. Only for the "no-op writes must not
 * re-render" assertions (`expect(after).toBe(before)`); use {@link getTabs}
 * for anything that reads values.
 */
export function getTabsRef(taskId: string): Tab[] | undefined {
  return useApp.getState().tabs[taskId];
}

/** One tab, or undefined when it is not (or no longer) there. */
export function getTab(taskId: string, tabId: string): Tab | undefined {
  return getTabs(taskId).find(t => t.id === tabId);
}

/**
 * One tab as a terminal tab. Throws when it is missing or is a file/diff tab,
 * so a test that silently started asserting on `undefined.workState` fails
 * where the mistake is rather than three lines later.
 */
export function getTerminalTab(taskId: string, tabId: string): TerminalTab {
  const tab = getTab(taskId, tabId);
  if (!tab) throw new Error(`no tab ${tabId} in task ${taskId}`);
  if (tab.type !== "terminal") throw new Error(`tab ${tabId} is a "${tab.type}" tab, not a terminal`);
  return tab;
}

/** The work state of an agent tab ("idle" | "working" | "done"), if set. */
export function getTabWorkState(taskId: string, tabId: string): WorkState | undefined {
  return getTerminalTab(taskId, tabId).workState;
}

/** When the tab last transitioned to "done" (drives the sticky-done window). */
export function getTabWorkDoneAt(taskId: string, tabId: string): number | undefined {
  return getTerminalTab(taskId, tabId).workDoneAt;
}

/** The tab's attention/done badge, or null when it carries none. */
export function getTabUnread(taskId: string, tabId: string): Unread | null {
  return getTerminalTab(taskId, tabId).unread ?? null;
}

/** The tab's pending message queue (the "ralph loop"). */
export function getTabQueue(taskId: string, tabId: string): QueueItem[] {
  return getTerminalTab(taskId, tabId).queue ?? [];
}

/** Which tab the task has focused. */
export function getActiveTabId(taskId: string): string | undefined {
  return useApp.getState().activeTab[taskId];
}

// ── seeds ─────────────────────────────────────────────────────────────

/** A terminal tab with sane defaults; override only what the case is about. */
export function makeTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    title: "claude",
    ptyId: "pty-1",
    cli: "claude",
    workState: "idle",
    workProgress: null,
    workProgressKind: null,
    workClearedAt: undefined,
    preview: false,
    ...overrides,
  } as TerminalTab;
}

/** A task row with sane defaults. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "Feature Foo", branch: "feature/foo",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    ...overrides,
  } as Task;
}

/** Append a tab to a task and make it the active one. */
export function seedTab(taskId: string, tab: Tab): void {
  useApp.setState(s => ({
    tabs: { ...s.tabs, [taskId]: [...(s.tabs[taskId] ?? []), tab] },
    activeTab: { ...s.activeTab, [taskId]: tab.id },
  }));
}

/**
 * Point the app at a task+tab, i.e. "the user is looking at this one". The
 * focused-tab rules (done → idle downgrade, isUserWatching) hang off this.
 */
export function focusTab(taskId: string, tabId: string): void {
  useApp.setState({ activeTaskId: taskId, activeTab: { [taskId]: tabId } } as never);
}

/** Back to a clean store. Call in `beforeEach`. */
export function resetAppStore(): void {
  useApp.setState({
    tabs: {},
    activeTab: {},
    activeTaskId: null,
    mountedTasks: new Set(),
    tasks: [],
    projects: [],
    agents: [],
  });
}
