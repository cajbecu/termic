// The "Copy agent CLI briefing" block: a paste-ready fragment that links one
// Termic task to another agent, so the two can hand each other work.
//
// It is a FRAGMENT, not a document: the user pastes it INSIDE a larger prompt
// they are writing for agent B, to point B at task A. So it carries only what
// B cannot derive - A's id, its directory, and the command shape - and leaves
// the protocol to the CLI's own help. `$TERMIC_CLI_HELP` is injected into
// every task PTY (lib.rs) and `termic send --help` carries the long version,
// so a Termic agent has already been told to prompt rather than `--wait`
// before it ever reads this paste. Re-teaching it here is what made an
// earlier draft 35 lines that nobody could read.
//
// The one load-bearing detail is the QUOTING. The reply address is
// `$TERMIC_TASK_ID` inside DOUBLE quotes, so the SENDER's shell expands it to
// the sender's own id at send time and the receiving agent is handed a literal
// address it can just run. Single quotes there would block expansion, and the
// block would have to spend a paragraph telling agents to substitute by hand,
// which is exactly the step they fumble.

import { copyToClipboard } from "@/lib/clipboard";
import { cliInstallStatus } from "@/lib/ipc";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import type { Task } from "@/lib/types";

/** What the snippet should put after `${TERMIC_CLI:-...}` as the fallback
 *  for an agent running OUTSIDE Termic, where $TERMIC_CLI is unset.
 *
 *  An installed link that is on the login PATH is the nicest thing to read
 *  (`termic`); installed but off-PATH has to be the absolute path or the
 *  paste silently doesn't work; not installed at all still yields the bare
 *  command name, which is right the moment the user enables the CLI. */
export function cliFallbackCommand(
  status: { path: string | null; name: string; on_path: boolean } | null,
): string {
  if (!status) return "termic";
  if (status.path && !status.on_path) return status.path;
  return status.name || "termic";
}

/** Resolve the fallback by asking the backend; never rejects. */
export async function resolveCliFallback(): Promise<string> {
  return cliFallbackCommand(await cliInstallStatus().catch(() => null));
}

/** Build the paste-ready fragment for one task.
 *
 *  `cli` is the command name/path to call (see cliFallbackCommand). Pure and
 *  synchronous so the copy path stays testable without touching IPC. */
export function buildAgentBriefing(opts: {
  task: Task;
  projectName?: string | null;
  cli: string;
}): string {
  const { task, cli } = opts;
  const project = opts.projectName || "unknown project";
  // An ENFORCING cage denies the control-plane socket outright (termic-cli's
  // cage_refused), so this agent cannot run the CLI to reply at all. One line,
  // and only on the tasks it applies to: without it the reader wires up a
  // report-back that can never arrive. Monitor mode reaches the CLI by
  // contract and needs no warning.
  //
  // This line is correct behaviour, NOT a gap to close by handing caged
  // agents a channel: a cage with a text channel to something uncaged is not
  // a cage. docs/sandbox.md ("Settled") has the argument, including why the
  // narrow versions of the idea fail too.
  const caged = isSandboxEnforced(effectiveSandboxMode(task))
    ? `\n\nIt is sandboxed (enforcing), so it cannot run the CLI to reply: ask it to write a file under dir and read that yourself.`
    : "";

  return `Termic task "${task.name}" (${project}), id ${task.id}, dir ${task.path}. Hand it work and get a reply with:

  ${cli} send ${task.id} -p "<your prompt here: what you want it to do>. When done: ${cli} send $TERMIC_TASK_ID -p 'done: <what you did>'"${caged}`;
}

/** Copy the briefing for `task` to the clipboard, resolving the CLI command
 *  first. Shared by the sidebar task menu and the command palette so the two
 *  can't drift. */
export async function copyAgentBriefing(task: Task, projectName?: string | null) {
  const cli = await resolveCliFallback();
  return copyToClipboard(buildAgentBriefing({ task, projectName, cli }), "agent CLI briefing");
}
