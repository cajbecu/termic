// What each language server is doing right now (GH #174).
//
// A cold rust-analyzer spends minutes indexing a crate graph, and until it is
// done hover and go-to-definition return nothing at all. Without a status that
// is indistinguishable from the feature being broken — the user asks a
// question, gets silence, and concludes it does not work. So the states a
// server can be in are modelled, and the chip that armed it says which one it
// is in.
//
// Keyed by checkout root + server, the same key the client is keyed by, since
// that is the thing being reported on: a server serves every task on its
// checkout, so its status is the checkout's, not a task's.

import { create } from "zustand";

export type LspPhase =
  /** Spawned, handshake not finished. */
  | "starting"
  /** The server told us it is busy (a `$/progress` report). */
  | "indexing"
  /** Answering questions. */
  | "ready"
  /** The process died, or never came up. */
  | "failed";

export interface LspStatus {
  phase: LspPhase;
  /** The server's own words: "Indexing", "Loading crate graph", … */
  message?: string;
  /** 0-100 when the server reports one. Servers often report none. */
  percent?: number;
}

interface LspStatusState {
  byKey: Record<string, LspStatus>;
  set: (key: string, status: LspStatus) => void;
  clear: (key: string) => void;
}

export const statusKey = (root: string, server: string) => `${root} ${server}`;

export const useLspStatus = create<LspStatusState>((set, get) => ({
  byKey: {},
  set: (key, status) => {
    const cur = get().byKey[key];
    // Progress notifications arrive several times a second while a big repo
    // indexes, and most of them say the same thing. An unchanged write copies
    // the whole store and re-runs every subscriber's selector
    // (docs/performance.md bear trap 8), on a path that fires at exactly the
    // moment the machine is busiest.
    if (cur && cur.phase === status.phase && cur.message === status.message
      && cur.percent === status.percent) return;
    set(s => ({ byKey: { ...s.byKey, [key]: status } }));
  },
  clear: (key) => {
    if (!(key in get().byKey)) return;
    set(s => {
      const byKey = { ...s.byKey };
      delete byKey[key];
      return { byKey };
    });
  },
}));

/**
 * The sentence the chip's tooltip leads with, or "" when there is nothing
 * worth saying.
 *
 * Phrasing lives here rather than in the component because it answers a
 * question the user is asking in the moment ("why did that hover do nothing?"),
 * and the answer has to name the wait AND its consequence. The chip itself
 * shows only a pulsing dot: a label that changed on every percentage would
 * reflow the path bar under the reader.
 */
export function statusDetail(status: LspStatus | undefined): string {
  if (!status) return "";
  switch (status.phase) {
    case "starting":
      return "The server is starting, so answers are incomplete until it is ready.";
    case "indexing": {
      const pct = status.percent != null ? ` ${Math.round(status.percent)}%` : "";
      return `${status.message ?? "Indexing"}${pct}: answers are incomplete until this finishes.`;
    }
    case "failed":
      return `The server stopped: ${status.message ?? "no reason given"}.`;
    case "ready":
      return "";
  }
}

/** Is the server in a state where it cannot answer yet? Drives the dot. */
export function isBusy(status: LspStatus | undefined): boolean {
  return status?.phase === "starting" || status?.phase === "indexing";
}
