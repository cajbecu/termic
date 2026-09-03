import { describe, it, expect, vi } from "vitest";
import {
  waitForAgentReady,
  READY_QUIET_MS,
  READY_FLOOR_MS,
  READY_PAINTING_DEADLINE_MS,
  READY_DEADLINE_MS,
} from "@/lib/agentReady";
import type { AgentReadyOutcome } from "@/lib/agentReady";
import type { TerminalTab } from "@/lib/types";

// Fake timers against the REAL constants, the way race.integration.test.ts
// drives the same path: the thresholds under test are the ones that ship,
// and no wall-clock is burned proving it.

/** PTY up, nothing painted yet: `lastOutputAt` holds the spawn stamp that
 *  TerminalPane writes beside `ptyId`, `firstOutputAt` is still null. */
function spawned(lastOutputAt: number): TerminalTab {
  return { id: "t1", type: "terminal", ptyId: "pty-1", lastOutputAt, firstOutputAt: null } as TerminalTab;
}

/** The same tab once the agent has painted. */
function painted(lastOutputAt: number): TerminalTab {
  return { ...spawned(lastOutputAt), firstOutputAt: lastOutputAt };
}

/** Start the wait and expose its outcome without awaiting it, so a test can
 *  assert what it has NOT done yet while stepping the clock. */
function start(tab: () => TerminalTab | undefined, hooksOwnReadiness = false) {
  const state: { outcome?: AgentReadyOutcome } = {};
  const done = waitForAgentReady(tab, { hooksOwnReadiness })
    .then(o => { state.outcome = o; return o; });
  return { state, done };
}

describe("waitForAgentReady", () => {
  it("settles once the agent paints and then goes quiet", async () => {
    vi.useFakeTimers();
    try {
      let tab = spawned(Date.now());
      const { state, done } = start(() => tab);

      await vi.advanceTimersByTimeAsync(300);
      expect(state.outcome).toBeUndefined();

      tab = painted(Date.now());
      // Quiet is satisfied here, the floor is not.
      await vi.advanceTimersByTimeAsync(READY_QUIET_MS + 100);
      expect(state.outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(READY_FLOOR_MS);
      expect(await done).toBe("settled");
    } finally { vi.useRealTimers(); }
  });

  it("does not treat the spawn stamp as the agent having painted", async () => {
    // The cold start that used to lose prompts: the PTY is up and quiet,
    // but nothing has been drawn. Waiting beats typing into a splash.
    vi.useFakeTimers();
    try {
      const tab = spawned(Date.now());
      const { state, done } = start(() => tab);

      // Past the 6s fixed sleep this replaced, and past the cap that
      // applies once an agent HAS painted: neither may fire here.
      await vi.advanceTimersByTimeAsync(READY_PAINTING_DEADLINE_MS + 1000);
      expect(state.outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS);
      expect(await done).toBe("deadline");
    } finally { vi.useRealTimers(); }
  });

  it("gives up on a chatty TUI near the old settle, not at the long deadline", async () => {
    // An agent repainting an idle status line never goes quiet. Waiting the
    // cold-start deadline out for one would make every prompt slower than
    // the fixed sleep this replaced.
    vi.useFakeTimers();
    try {
      let tab = painted(Date.now());
      const repaint = setInterval(() => { tab = painted(Date.now()); }, READY_QUIET_MS / 2);
      const { state, done } = start(() => tab);

      await vi.advanceTimersByTimeAsync(READY_PAINTING_DEADLINE_MS - 500);
      expect(state.outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1000);
      clearInterval(repaint);
      expect(await done).toBe("deadline");
    } finally { vi.useRealTimers(); }
  });

  it("counts a paint that happened before the wait started", async () => {
    // Readiness is state, not a snapshot taken at the right moment: an
    // agent whose banner landed before anyone polled has painted.
    vi.useFakeTimers();
    try {
      const tab = painted(Date.now());
      const { done } = start(() => tab);
      await vi.advanceTimersByTimeAsync(READY_FLOOR_MS + READY_QUIET_MS);
      expect(await done).toBe("settled");
    } finally { vi.useRealTimers(); }
  });

  it("gives up when the tab loses its PTY", async () => {
    vi.useFakeTimers();
    try {
      let tab: TerminalTab = painted(Date.now());
      const { done } = start(() => tab);
      setTimeout(() => { tab = { ...tab, ptyId: undefined }; }, 300);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await done).toBe("lost");
    } finally { vi.useRealTimers(); }
  });
});

describe("readiness reported by the agent's own hook", () => {
  it("is taken immediately, without waiting out the floor", async () => {
    // The floor and the quiet window exist to APPROXIMATE this. Once the
    // agent has said it, there is nothing left to approximate, and making a
    // link-delivered prompt sit through 3s of guessing helps nobody.
    vi.useFakeTimers();
    try {
      const tab = { ...spawned(Date.now()), agentReadyAt: Date.now() } as TerminalTab;
      const { state, done } = start(() => tab, true);
      await vi.advanceTimersByTimeAsync(200);
      expect(state.outcome).toBe("ready");
      expect(await done).toBe("ready");
    } finally { vi.useRealTimers(); }
  });

  it("blocks rather than guessing when the hook stays silent", async () => {
    // The bug this exists for. claude's trust picker paints and then goes
    // quiet, which is byte-for-byte a waiting input box, so the heuristic
    // called it settled and typed. The submit confirmed the highlighted
    // `No, exit` and killed the agent. With hooks installed, quiet is no
    // longer evidence of anything.
    vi.useFakeTimers();
    try {
      const tab = painted(Date.now());
      const { state, done } = start(() => tab, true);
      // Long past the point the heuristic would have declared "settled".
      await vi.advanceTimersByTimeAsync(READY_QUIET_MS + READY_FLOOR_MS + 500);
      expect(state.outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS);
      expect(await done).toBe("blocked");
    } finally { vi.useRealTimers(); }
  });

  it("still settles on quiet for an agent with no hooks", async () => {
    // The fallback must be untouched: most agents report nothing, and
    // refusing to type for them would trade a rare dead agent for a
    // universal undelivered prompt.
    vi.useFakeTimers();
    try {
      const tab = painted(Date.now());
      const { done } = start(() => tab, false);
      await vi.advanceTimersByTimeAsync(READY_QUIET_MS + READY_FLOOR_MS + 200);
      expect(await done).toBe("settled");
    } finally { vi.useRealTimers(); }
  });

  it("prefers a late hook signal over the painting deadline", async () => {
    // A chatty agent never looks quiet, so the heuristic gives up at the
    // painting deadline and types anyway. A hook arriving in that window is
    // better evidence and must win.
    vi.useFakeTimers();
    try {
      let tab = painted(Date.now());
      const { state, done } = start(() => tab, true);
      await vi.advanceTimersByTimeAsync(READY_PAINTING_DEADLINE_MS + 300);
      expect(state.outcome).toBeUndefined();
      tab = { ...tab, agentReadyAt: Date.now() } as TerminalTab;
      await vi.advanceTimersByTimeAsync(300);
      expect(await done).toBe("ready");
    } finally { vi.useRealTimers(); }
  });

  it("reports a lost pty ahead of everything else", async () => {
    vi.useFakeTimers();
    try {
      const { done } = start(() => ({ id: "t1", type: "terminal" } as TerminalTab), true);
      await vi.advanceTimersByTimeAsync(300);
      expect(await done).toBe("lost");
    } finally { vi.useRealTimers(); }
  });
});
