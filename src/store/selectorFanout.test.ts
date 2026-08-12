// @vitest-environment happy-dom
//
// Selector fan-out budget (performance.md bear trap 5).
//
// The rule this guards: tight Zustand selectors, and frozen EMPTY constants
// for the absent case, so an unrelated write does not invalidate every
// subscriber. The regression it exists to catch is someone selecting a whole
// slice (or building a fresh array/object inside a selector), which turns one
// sidebar-drag frame into a re-render of every mounted tab bar.
//
// Why this shape rather than a wall-clock benchmark: the count is
// machine-independent, so it can gate a PR on a 3-core CI VM. Timings cannot.
// See docs/research/perf-ci.md for the full argument. The one time assertion
// here is a loose backstop with orders of magnitude of headroom, not a budget.
//
// This models `useSyncExternalStore` exactly: on every store notification each
// mounted subscriber re-runs its selector, and re-renders if and only if the
// new snapshot differs from the old one by Object.is.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocks as app.test.ts — importing the store pulls in the ipc layer.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useApp, selectTaskTabs, selectActiveTabId, EMPTY_TABS } from "@/store/app";
import type { AppState } from "@/store/app";
import type { Tab } from "@/lib/types";

/** Mounted subscribers to simulate. A busy window is a handful of panes, not
 *  2500 — but the budget should hold with two orders of magnitude of slack. */
const SUBSCRIBERS = 500;
/** Unrelated writes. A sidebar drag at 120 Hz for ~8 seconds. */
const WRITES = 1000;
/** Loose wall-clock backstop. Not a perf budget: purely a tripwire for
 *  accidentally quadratic selector work. Real value on a dev box is ~0.001. */
const MAX_MS_PER_WRITE = 2;

interface FanoutResult {
  selectorRuns: number;
  invalidations: number;
  msPerWrite: number;
}

/** Run `write` `times` times with `subs` selectors mounted, counting how often
 *  each selector ran and how often its snapshot actually changed identity. */
function measureFanout(
  subs: ((s: AppState) => unknown)[],
  times: number,
  write: (i: number) => void,
): FanoutResult {
  let selectorRuns = 0;
  let invalidations = 0;

  const snapshots = subs.map(sel => sel(useApp.getState()));
  const unsub = useApp.subscribe(() => {
    for (let i = 0; i < subs.length; i++) {
      selectorRuns++;
      const next = subs[i](useApp.getState());
      if (!Object.is(next, snapshots[i])) {
        invalidations++;
        snapshots[i] = next;
      }
    }
  });

  const t0 = performance.now();
  for (let i = 0; i < times; i++) write(i);
  const elapsed = performance.now() - t0;
  unsub();

  return { selectorRuns, invalidations, msPerWrite: elapsed / times };
}

function tab(id: string): Tab {
  return { id, type: "terminal", title: id, cli: "claude" } as Tab;
}

describe("selector fan-out budget (bear trap 5)", () => {
  beforeEach(() => {
    useApp.setState({ tabs: {}, activeTab: {}, sidebarWidth: 260 });
  });

  it("a sidebar drag invalidates no tab selector", () => {
    // The hot path: `setSidebarWidth` fires once per pointer-move while the
    // user drags the sidebar edge. Every mounted tab bar has a `useTaskTabs`
    // subscription. None of them may re-render.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));

    expect(r.invalidations).toBe(0);
    // Sanity: the harness really did exercise every selector on every write.
    // Without this, `invalidations === 0` could pass vacuously.
    expect(r.selectorRuns).toBe(SUBSCRIBERS * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("detects fan-out when a selector is not tight (positive control)", () => {
    // Proves the harness can fail. A selector that reads the whole `tabs`
    // record is stable here, but one that derives a fresh array is not — this
    // is precisely the mistake bear trap 5 describes.
    useApp.setState({ tabs: { a: [tab("a-1")] } });
    const loose = [(s: AppState) => Object.keys(s.tabs).map(k => k)];

    const r = measureFanout(loose, 10, i =>
      useApp.getState().setSidebarWidth(200 + i));

    expect(r.invalidations).toBe(10);
  });

  it("a write to one task invalidates only that task's selector", () => {
    const ids = ["a", "b", "c"];
    useApp.setState({ tabs: Object.fromEntries(ids.map(id => [id, [tab(`${id}-1`)]])) });
    const subs = ids.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b: [tab("b-1"), tab("b-2")] } });
    });

    expect(r.invalidations).toBe(1);
  });

  it("absent tasks share one frozen EMPTY_TABS reference", () => {
    // This is what keeps `invalidations` at 0 for a task with no tabs yet.
    // A `?? []` here would allocate per call and re-render every frame.
    const s = useApp.getState();
    expect(selectTaskTabs("nope")(s)).toBe(EMPTY_TABS);
    expect(selectTaskTabs("nope")(s)).toBe(selectTaskTabs("other")(s));
    expect(selectTaskTabs(null)(s)).toBe(EMPTY_TABS);
    expect(Object.isFrozen(EMPTY_TABS)).toBe(true);
  });

  it("activeTab selectors are undefined-stable for unknown tasks", () => {
    // `undefined` is Object.is-stable, so an unknown task never invalidates.
    const subs = Array.from({ length: 50 }, (_, i) => selectActiveTabId(`ghost-${i}`));
    const r = measureFanout(subs, 100, i =>
      useApp.getState().setSidebarWidth(200 + (i % 60)));
    expect(r.invalidations).toBe(0);
  });
});
