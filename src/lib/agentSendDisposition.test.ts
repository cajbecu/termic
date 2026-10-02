import { describe, expect, it } from "vitest";
import { agentSendDisposition, type SendDispositionInput } from "./agentSendDisposition";

const base: SendDispositionInput = {
  capable: true, workState: "idle", delegatedIdle: false, queued: 0, composing: false,
};

describe("agentSendDisposition", () => {
  it("types into an idle agent", () => {
    expect(agentSendDisposition(base)).toBe("deliver");
  });

  it("queues behind a turn in progress", () => {
    expect(agentSendDisposition({ ...base, workState: "working" })).toBe("queue");
  });

  it("queues behind messages already waiting", () => {
    expect(agentSendDisposition({ ...base, queued: 3 })).toBe("queue");
  });

  // THE bug. The agent's own loop has stopped while subagents it started keep
  // running, so no work-done edge is coming and nothing will drain the queue.
  // `delegatedIdle` already let ONE message past `working`; the backlog clause
  // meant the second and every one after it queued behind the first, and the
  // pile sat there. Reported as five queued behind an agent waiting on two.
  it("releases the backlog when the agent is waiting on delegated work", () => {
    expect(agentSendDisposition({ ...base, workState: "working", delegatedIdle: true, queued: 5 }))
      .toBe("queue-flush");
  });

  it("delivers straight away when delegated and nothing is waiting", () => {
    expect(agentSendDisposition({ ...base, workState: "working", delegatedIdle: true }))
      .toBe("deliver");
  });

  it("never interrupts the USER's half-typed message", () => {
    // Outranks even the deadlock: merging a machine's message into someone's
    // draft is worse than waiting, and the draft ends when they press Enter.
    for (const extra of [
      { delegatedIdle: true, queued: 5 },
      { workState: "idle" as const },
      { capable: false },
    ]) {
      expect(agentSendDisposition({ ...base, ...extra, composing: true })).toBe("queue");
    }
  });

  it("delivers to an agent with no work-done detection rather than queueing forever", () => {
    // No turn-end edge exists for these, so a queue is a black hole.
    expect(agentSendDisposition({ ...base, capable: false, workState: "working", queued: 2 }))
      .toBe("deliver");
  });

  it("does not flush for an ordinary busy agent", () => {
    // The flush is only ever the delegated escape hatch: a normal turn ends on
    // its own and the drain handles it in order.
    expect(agentSendDisposition({ ...base, workState: "working", queued: 9 })).toBe("queue");
  });
});
