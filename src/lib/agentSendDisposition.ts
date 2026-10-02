// What to do with a message an AGENT sends another agent (`termic send`, MCP
// `task_send`): type it now, queue it, or queue it and release the backlog.
//
// Three answers rather than two, and the third is the one this file exists
// for. An agent that has delegated work is NOT mid-turn: its own loop has
// stopped while subagents or shells it started keep running, so there is no
// turn left to wait for and no work-done edge coming to drain the queue on.
// A message that queues there can sit forever, which is what "5 queued" behind
// an agent waiting on two others looks like.
//
// Pure, because the rule is four flags and the failure mode is a deadlock
// nobody sees until an agent has been silent for ten minutes.

export type SendDisposition =
  /** Type it into the PTY now. */
  | "deliver"
  /** Hold it; the turn's end will drain it. */
  | "queue"
  /** Hold it, then release the WHOLE queue back to back. */
  | "queue-flush";

export interface SendDispositionInput {
  /** Does this agent report work-done at all? Without it there is no "turn
   *  ended" edge, so queueing would mean sitting forever. */
  capable: boolean;
  /** The tab's work state. Only "working" blocks. */
  workState: string | null | undefined;
  /** The agent's own loop stopped with delegated work outstanding. */
  delegatedIdle: boolean;
  /** How many messages are already waiting. */
  queued: number;
  /** The USER has an unsubmitted draft in the prompt. Typing now would land
   *  inside their text and Enter would send both as one message. */
  composing: boolean;
}

export function agentSendDisposition(i: SendDispositionInput): SendDisposition {
  // The user's half-typed message outranks everything, including a deadlock:
  // merging a machine's message into a person's draft is worse than waiting,
  // and the draft ends on its own the moment they press Enter.
  if (i.composing) return "queue";

  // No work-done detection: there is no edge to drain on, so queueing is a
  // black hole. This is the pre-existing rule and it stays.
  if (!i.capable) return "deliver";

  // Delegated-idle: nothing is coming to release a queue here. With a backlog,
  // flush it (ordered, oldest first, the new one last) rather than delivering
  // ahead of messages that were already waiting. Reordering a conversation to
  // fix a liveness bug trades one wrong answer for another.
  if (i.delegatedIdle) return i.queued > 0 ? "queue-flush" : "deliver";

  // Genuinely mid-turn, or something is already waiting: get in line.
  if (i.workState === "working" || i.queued > 0) return "queue";
  return "deliver";
}
