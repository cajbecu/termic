// The "Copy agent CLI briefing" block: a paste-ready briefing that teaches ANY
// other coding agent how to drive one Termic task.
//
// The point is agent-to-agent orchestration. You copy it from task A and
// paste it into agent B, and B can now hand A work and read what it did.
//
// It deliberately steers both sides AWAY from `--wait`. Waiting binds one
// agent's liveness to our work-done heuristic, which is a guess (a settled
// terminal is not a finished job), and a blocked agent can't answer anything
// else in the meantime. The reliable protocol is symmetric prompts: every
// prompt you send carries the command to run when the work is done, and the
// receiving agent decides when to run it. A prompt landing in a Termic agent's
// terminal IS the notification.
//
// Kept in lockstep with docs/cli-agent-instructions.md, the `send` help text
// in termic-cli, and the $TERMIC_CLI_HELP the Rust side exports into every
// task PTY (lib.rs). All four teach the same protocol.

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

/** Shell-quote for the single-quoted `-p '...'` example. */
function shellSingle(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/** Build the paste-ready block for one task.
 *
 *  `cli` is the fallback command name/path (see cliFallbackCommand). Pure and
 *  synchronous so the copy path stays testable without touching IPC. */
export function buildAgentBriefing(opts: {
  task: Task;
  projectName?: string | null;
  cli: string;
}): string {
  const { task, cli } = opts;
  const project = opts.projectName || "unknown project";
  const agent = task.cli || "claude";
  // The example prompt names the task so the reply that comes back is
  // self-identifying in a busy orchestrator's terminal.
  const reply = shellSingle(`${task.name}: done, RESULT.md written`);
  // An ENFORCING cage denies the control-plane socket outright (termic-cli's
  // cage_refused), so this agent has no way to prompt anyone back. Saying so
  // is the difference between "ask for a file" and a protocol that silently
  // never reports. Monitor mode is exempt by contract and needs no warning.
  const caged = isSandboxEnforced(effectiveSandboxMode(task))
    ? `

CAVEAT: this task runs in an ENFORCING sandbox, so the agent inside it cannot
run the termic CLI at all (it is refused with "the control plane is
unavailable"). It cannot report back to you. Ask it in the prompt to write a
file instead, and read that file yourself under DIR, which is readable from
out here. Sending it work still works; only its outbound half is missing.`
    : "";

  return `Termic task "${task.name}" (project ${project}, agent ${agent}).
It is a live coding agent working in its own git worktree. You can hand it
work and read what it did. The \`termic\` CLI is its remote control; the
running Termic app is the daemon that answers.

  CLI="\${TERMIC_CLI:-${cli}}"   # $TERMIC_CLI is already set inside a Termic task
  TASK=${task.id}   # the id is stable; the task's name can be changed
  DIR=${task.path}

What you can do with it:

  "$CLI" send   "$TASK" -p "<what you want done>"   # prompt it (queues mid-turn)
  "$CLI" status "$TASK" --json                      # state, tabs, queued prompts
  "$CLI" diff   "$TASK" --json                      # what it has changed so far
  "$CLI" result "$TASK"                             # its last message (claude only)
  "$CLI" help --json                                # every command and exit code

HOW TO TALK TO IT: prompt each other. Do not use --wait.

--wait blocks you until Termic's work-done heuristic says the agent stopped,
which is a guess, not a promise that the work is finished or correct, and
while you are blocked you cannot do anything else. So don't wait on it: put
the callback INSIDE the prompt and let the other agent choose the moment.

  "$CLI" send "$TASK" -p 'Review the auth module. Write your findings to
  RESULT.md in your worktree, and change nothing else.
  When you are done, tell me by running:
    "$TERMIC_CLI" send <YOUR-TASK-ID> -p "${reply}"'

Substitute <YOUR-TASK-ID> with the literal value of your own $TERMIC_TASK_ID
before you send it: the other agent's shell cannot expand your variables.
Every prompt you send should end with a report-back line like that, and every
prompt that arrives in your own terminal is one of those reports, to act on.

If you are NOT running inside a Termic task you have no inbox to be prompted
back at. Then ask for a file (RESULT.md above) and read it when you next have
a reason to, rather than blocking on --wait.${caged}

Never edit Termic's own data files; the CLI is the only interface.`;
}

/** Copy the briefing for `task` to the clipboard, resolving the CLI fallback
 *  first. Shared by the sidebar task menu and the command palette so the two
 *  can't drift. */
export async function copyAgentBriefing(task: Task, projectName?: string | null) {
  const cli = await resolveCliFallback();
  return copyToClipboard(buildAgentBriefing({ task, projectName, cli }), "agent CLI briefing");
}
