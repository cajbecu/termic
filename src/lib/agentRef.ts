// Push an editor selection at the agent as an `@file:line` reference
// (roadmap item 8, GH #174).
//
// Deliberately NOT a submitted prompt: the reference is TYPED into the agent's
// input and left there, uncommitted, with a trailing space. The user selects
// code, fires this, and finishes the sentence themselves ("explain this",
// "make it async"). That is the difference between handing the agent context
// and guessing what the user wanted done with it, and it is why this writes
// raw bytes rather than going through agentSend's text-then-CR delivery.

import { ptyWrite } from "./ipc";
import { shellEscapePath } from "./terminalDrop";
import { isTerminalCli, tabLabel } from "./agents";
import { focusTerminalTab } from "./tabFocus";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { TerminalTab } from "./types";

/**
 * One `@path` reference, optionally pinned to a line or a line range.
 *
 * `@src/lib/foo.ts`, `@src/lib/foo.ts:12`, `@src/lib/foo.ts:12-40`. The path is
 * escaped the same way a file dragged onto a terminal is (`shellEscapePath`),
 * so a space or a paren in a filename survives into the agent's input instead
 * of splitting the reference in two.
 *
 * Lines are 1-based; a reversed or out-of-range pair is normalized rather than
 * rejected, since it comes from a live selection. The trailing space is part of
 * the contract: the user types their question straight after it.
 */
export function formatAgentRef(path: string, startLine?: number, endLine?: number): string {
  const ref = `@${shellEscapePath(path)}`;
  if (startLine == null || !Number.isFinite(startLine)) return `${ref} `;
  const a = Math.max(1, Math.floor(startLine));
  const b = endLine == null || !Number.isFinite(endLine) ? a : Math.max(1, Math.floor(endLine));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo === hi ? `${ref}:${lo} ` : `${ref}:${lo}-${hi} `;
}

/** Live agent terminals for a task: real agents only, never a plain shell, a
 *  custom-command tab, a run tab, or a registry "terminal"-kind entry. Same
 *  filter the review-comment sender uses, for the same reason: a reference is
 *  context for an agent, and typing it into a dev server is noise. */
export function agentTargets(taskId: string): TerminalTab[] {
  const s = useApp.getState();
  return (s.tabs[taskId] ?? []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal" && !!t.ptyId && !t.runTab && !isTerminalCli(t.cli, s.agents),
  );
}

/** Which agent gets the reference: the active tab when it is one, else the
 *  task's default agent, else the first live one. */
export function pickAgentTarget(taskId: string): TerminalTab | null {
  const targets = agentTargets(taskId);
  const activeTabId = useApp.getState().activeTab[taskId];
  return (
    targets.find(t => t.id === activeTabId) ??
    targets.find(t => t.is_default) ??
    targets[0] ??
    null
  );
}

/**
 * Type `ref` into the task's agent terminal and put the user in front of it.
 *
 * Resolves true when the bytes reached the PTY. Never submits (no CR), never
 * queues: a busy agent still gets the text, it just sits in its input until the
 * turn ends, which is exactly what typing it by hand would do.
 */
export async function sendAgentRef(taskId: string, ref: string): Promise<boolean> {
  const target = pickAgentTarget(taskId);
  if (!target?.ptyId) {
    useUI.getState().pushToast("No running agent in this task to send to.", "error");
    return false;
  }
  try {
    await ptyWrite(target.ptyId, Array.from(new TextEncoder().encode(ref)));
  } catch {
    useUI.getState().pushToast(`Could not reach ${tabLabel(target)}.`, "error");
    return false;
  }
  // Surface the agent we just typed into, and drop keyboard focus there so the
  // next thing the user types continues the line. No lastInputAt stamp: nothing
  // was submitted, so there is no turn for work-done detection to arm against.
  useApp.getState().setActiveTabId(taskId, target.id);
  focusTerminalTab(target.id);
  useUI.getState().pushToast(`Sent ${ref.trim()} to ${tabLabel(target)}`, "success");
  return true;
}
