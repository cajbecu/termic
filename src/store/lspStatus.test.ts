import { describe, it, expect, beforeEach } from "vitest";
import { useLspStatus, statusKey, statusDetail, isBusy } from "./lspStatus";

// A cold rust-analyzer indexes for minutes, and until it finishes hover and
// go-to-definition come back empty. Silence there reads as "this feature does
// not work", so what the server is doing has to be sayable.

describe("language-server status", () => {
  beforeEach(() => useLspStatus.setState({ byKey: {} }));

  it("keys status by checkout and server, like the client itself", () => {
    // One server serves every task on a checkout, so its status belongs to the
    // checkout rather than to whichever task happens to be on screen.
    expect(statusKey("/repos/a", "rust")).toBe("/repos/a rust");
    expect(statusKey("/repos/a", "rust")).not.toBe(statusKey("/repos/b", "rust"));
  });

  it("does not write when nothing changed", () => {
    // `$/progress` arrives several times a second while a big repo indexes,
    // usually saying the same thing. An unchanged write copies the store and
    // re-runs every selector, at the moment the machine is busiest
    // (docs/performance.md bear trap 8).
    const key = statusKey("/repos/a", "rust");
    useLspStatus.getState().set(key, { phase: "indexing", message: "Indexing", percent: 12 });
    const before = useLspStatus.getState().byKey;
    useLspStatus.getState().set(key, { phase: "indexing", message: "Indexing", percent: 12 });
    expect(useLspStatus.getState().byKey).toBe(before);
    useLspStatus.getState().set(key, { phase: "indexing", message: "Indexing", percent: 13 });
    expect(useLspStatus.getState().byKey).not.toBe(before);
  });

  it("clears a key only when it is there", () => {
    const before = useLspStatus.getState().byKey;
    useLspStatus.getState().clear("nothing here");
    expect(useLspStatus.getState().byKey).toBe(before);
  });
});

describe("what the tooltip says", () => {
  it("says nothing at all once the server is ready", () => {
    // A working feature needs no explanation; the chip already reads
    // "Code intelligence" with a compass beside it.
    expect(statusDetail({ phase: "ready" })).toBe("");
    expect(statusDetail(undefined)).toBe("");
  });

  it("names the wait AND its consequence", () => {
    // The user is asking "why did that hover do nothing?". Naming the phase
    // without saying answers are incomplete would not answer them.
    expect(statusDetail({ phase: "starting" })).toContain("incomplete");
    expect(statusDetail({ phase: "indexing" })).toBe(
      "Indexing: answers are incomplete until this finishes.");
    // The server's own words when it has some: "Indexing" and "Loading crate
    // graph" are different waits.
    expect(statusDetail({ phase: "indexing", message: "Loading crate graph", percent: 42.4 }))
      .toBe("Loading crate graph 42%: answers are incomplete until this finishes.");
  });

  it("says when the server died rather than looking healthy", () => {
    expect(statusDetail({ phase: "failed", message: "spawn failed" }))
      .toBe("The server stopped: spawn failed.");
    expect(statusDetail({ phase: "failed" })).toContain("no reason given");
  });
});

describe("when the dot pulses", () => {
  it("pulses only while the server cannot answer", () => {
    expect(isBusy({ phase: "starting" })).toBe(true);
    expect(isBusy({ phase: "indexing" })).toBe(true);
    // Ready and failed are both settled: one works, the other is over. A dot
    // still pulsing on a dead server would promise an answer that is not
    // coming.
    expect(isBusy({ phase: "ready" })).toBe(false);
    expect(isBusy({ phase: "failed" })).toBe(false);
    expect(isBusy(undefined)).toBe(false);
  });
});
