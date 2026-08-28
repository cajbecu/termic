# Agent lifecycle hooks

**Approved, ready to implement.** Everything here is measured against live CLIs
on 2026-08-28, not read from vendor documentation. Every vendor doc consulted was
wrong about something load-bearing, so treat the appendix as the source of truth
and re-measure before trusting any statement about an agent not listed there.

## What to build

Install one hook into the user's global Claude config so termic learns the moment
Claude blocks on the user, instead of reading its terminal title, which says the
opposite. Ship it off by default, behind a Settings toggle with a working
uninstall, plus a wizard step.

Phase 2 adds opencode through its plugin API. Codex is out of scope on evidence.

## The defect this fixes

Claude paints its **idle** glyph while blocked on a permission prompt, a
question, or plan approval. Measured:

```
29.774  HOOK  PreToolUse         tool_name=Write
29.787  OSC   0;* Create out.txt file    <- idle glyph. Agent is BLOCKED.
29.807  HOOK  PermissionRequest  tool_name=Write        <- the signal we want
34.79   (termic fires a FALSE "done": SETTLE_MS is 5s)
35.830  HOOK  Notification       notification_type=permission_prompt
35.831  OSC   9;Claude needs your permission   <- termic's first honest hint
```

So today the user gets a "done" badge and bell about a second before they get the
correct "needs you". `PermissionRequest` arrives at +20ms and closes that window
entirely.

## Scope

| Agent | In? | Why |
|---|---|---|
| Claude Code | **yes, phase 1** | Only signal that does not lie. See above. |
| opencode | **yes, phase 2** | No busy/idle OSC at all, and the only agent that reports `permission.replied`. |
| Codex | no | Its title already says `Action Required` at +22ms. Hooks add 10ms and cost a blocking trust modal that re-prompts on every hook-set change. |
| Grok | guard only | Reads our Claude file (see Grok guard). Its own adapter is later. |
| Antigravity | no | Loads a hook config and never invokes it. |
| Gemini, Copilot, Cursor | no | Unmeasured. Do not write adapters from their docs. |

## Phase 1: Claude, exactly one hook

### Why only one

`UserPromptSubmit`, `Stop` and `SessionStart` were all considered and rejected,
because termic already has each signal at the same instant or better:

- **working**: the title spinner already marks it.
- **done**: `Stop` fires 12ms *before* the idle title, and both feed the same 5s
  settle. No user-visible gain.
- **correlation**: `TERMIC_TASK_ID` is already injected into every agent PTY
  (`lib.rs:3079`) and reaches every child, caged included.

Registering them would add process spawns per turn for nothing. **Do not add
per-tool-call hooks (`PreToolUse`, `PostToolUse`, `PostToolBatch`) under any
circumstances**: they fire on every tool call.

### The transport: no IPC at all

A Claude hook's stdout JSON may carry `terminalSequence`, which Claude writes to
its own PTY. termic already parses the result. Verified end to end: the sequence
lands verbatim 6-8ms after the hook fires.

Allowlist, quoted from the Claude binary: *"only OSC 0/1/2/9/99/777 and BEL are
permitted, and OSC 9 bodies may not begin with a digit unless in the 9;4 progress
form"*.

This needs no socket, no callback binary, no sandbox grant and no Docker
plumbing, because the channel is the PTY the agent already owns. It works
identically unsandboxed, under Seatbelt and in Docker.

**Constraint, measured: it requires a synchronous hook.** With `"async": true`
the sequence is silently dropped and no OSC arrives at all. Do not set `async`.

### Which OSC to emit

Emit **OSC 777** (`notify`). termic already registers a handler for it
(`TerminalPane.tsx:1467`) which routes to `notifyAttention` and then
`goAttention`. `goAttention` calls `cancelSettle`, which is precisely what kills
the false done armed 20ms earlier by the idle title.

**No change to `TerminalPane` is required for phase 1.** That is the point.

The body must not match `BUILTIN_NOTIFY_IGNORE.claude`, which is
`["is waiting for your input"]` (`lib/agents.ts:396`). Use a body that says what
is happening without that phrase.

OSC 99 is free (termic registers 9, 777, 133, 1337 only) and is on Claude's
allowlist. Keep it in reserve if the `notifyAttention` filtering proves wrong;
using it needs a new handler.

### The hook script

One file per event, a bare absolute path with no arguments. Payload arrives on
stdin and phase 1 ignores it, so there is no JSON parsing, no `jq`, no `node`,
and no quoting hazard inside JSON-inside-settings.

The escape and bell are written as JSON `\u001b` / `\u0007` escapes, never as raw
control bytes, so the file stays copy-pasteable and diffable:

```sh
#!/bin/sh
# termic agent hook (generated; safe to delete).
# Tells termic the agent is blocked on you. Writes one OSC sequence to the
# agent's own terminal. No network, no files, no arguments.
[ -n "$TERMIC_TASK_ID" ] || exit 0    # not a termic PTY: stay silent
[ -z "$GROK_HOOK_EVENT" ] || exit 0   # grok reads this file too (see below)
printf '%s' '{"terminalSequence":"\u001b]777;notify;termic;agent needs your input\u0007"}'
exit 0
```

Three properties that are not optional:

- **Exit 0 on every path.** A hook must never be why an agent stalls.
- **The `TERMIC_TASK_ID` gate.** The install is global, so this script runs in
  every terminal the user launches Claude in, not only termic. Without the gate
  we would write OSC into iTerm, Ghostty, and CI.
- **The `GROK_HOOK_EVENT` gate.** See below.

### Where the script lives

`~/.claude/termic-hooks/` (inside the agent's own config dir), **not** the termic
data dir.

Seatbelt denies the data dir both read and write (`sandbox.rs:1239-1240`), and
`$HOME/.config` is not among `system_read_roots()` (`sandbox.rs:379`), so a caged
agent could not exec a script in either. The agent's own config dir is already
readable in the cage, and `(allow process-exec)` is unconditional
(`sandbox.rs:1826`). So this location needs **no sandbox change at all**, which
is the whole reason to prefer it.

### The settings.json entry

Written to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/<user>/.claude/termic-hooks/permission-request.sh",
            "timeout": 5,
            "statusMessage": "termic: reporting that you are needed"
          }
        ]
      }
    ]
  }
}
```

Do **not** set `async`. Do **not** emit `decision`, `permissionDecision`,
`continue`, or any other control field: we observe, we never gate.

## The config writer

The user may already have hand-written hooks. `~/.claude/settings.json` on the
maintainer's own machine already has a `hooks` key.

- Read and preserve **every** unknown key. Claude's schema tolerated our extra
  keys, but do not rely on that: Codex's rejects the whole file on one unknown
  top-level key, and the same authors write both.
- Append into the existing `PermissionRequest` array rather than replacing it.
- **Identify our entries by `command` path prefix**
  (`<home>/.claude/termic-hooks/`), not by a marker key. A marker requires the
  schema to tolerate unknown fields; the path does not, and it survives a user
  reformatting the file.
- Install is idempotent: an existing entry with our path prefix is replaced, not
  duplicated.
- Removal deletes only entries with our path prefix, then removes arrays and
  objects that become empty **and that we created**, leaving the file
  byte-identical to its pre-install state when nothing else changed.
- Write atomically (temp file, `rename`). A half-written `settings.json` breaks
  the user's agent, not just termic.
- Back the original file up once per agent on first install.
- Record what was installed in `~/.claude/termic-hooks/manifest.json` (schema
  version, paths, install time) so a future version knows what to remove.
- If the file is malformed JSON, **do not write**. Surface a settings-level error
  naming the file.
- Honour `disableAllHooks`: if set, the install is a no-op and the UI must say so
  rather than report success.

## Sandbox and Docker

- **Seatbelt**: nothing to grant, by construction (see "Where the script lives").
  The control socket stays denied, as `docs/plans/cli.md` settled.
- **Docker**: a **separate install target**. The agent config dir is
  `<data_dir>/docker-agents/<agent_id>/` (`docker.rs:349`), which termic owns, so
  writing there mutates nothing of the user's and needs no consent step. It can
  be on by default.
  - The path written into that `settings.json` must be the **container** path
    (`/root/.claude/termic-hooks/...`), not the host path. The dir is mounted at
    `CONTAINER_HOME`, so it is deterministic.
  - **Clone trap**: the host dir is keyed on the agent's OWN id, while the schema
    shape comes from `base_agent_id` (`docker.rs`). Iterate accordingly or clones
    get nothing.
- **Linux**: no Seatbelt exists (`sandbox.rs` has no `cfg(target_os)`); Docker is
  the Linux cage. Config paths are the same `~/.claude`.

## The Grok guard (not optional)

**Grok reads the global `~/.claude/settings.json`.** Measured, not inferred: with
a scratch `HOME` containing only our Claude hooks, grok ran them and stamped
`GROK_HOOK_NAME=global/settings:session_start[0].hooks[0]` into the environment.

So installing for Claude installs for Grok on every machine with both. Grok also
sets `CLAUDE_PROJECT_DIR` itself, so that variable cannot tell them apart.

Consequences the script's `GROK_HOOK_EVENT` gate handles:

- Grok's payload is **camelCase** (`hookEventName`, `sessionId`, `cwd`,
  `workspaceRoot`), and the event value inside is snake_case
  (`"hookEventName": "notification"`) even though the config key is PascalCase. A
  Claude-shaped reader sees undefined everywhere.
- Grok's output contract is `{"decision", "reason"}` with exit 2 to deny. It has
  no `terminalSequence`, so emitting ours there is useless.
- The user consented to termic writing Claude's config, not to changing an agent
  the Settings pane never listed.

Also measured: if both a Claude file and a project-local `.grok/hooks/*.json`
exist, **every event fires twice** (24 from `global/settings`, 24 from
`project/termic-lab`). Never install both.

## Settings and wizard

Settings → Notifications:

> **Exact needs-you detection**
> Installs a small hook into your Claude config so termic knows the moment
> Claude is waiting on you, instead of guessing from the terminal. Off by
> default.
> Files changed: `~/.claude/settings.json`, `~/.claude/termic-hooks/`
> [Install] [Remove]

- Off by default. Flip only once field data shows it stable.
- List the exact files **before** writing, not after.
- Show per-agent state the way Settings → Coding Agents lists detected CLIs.
  An agent detected but unsupported (Antigravity) must say so, not appear wired.
- "Remove" is always available even when the toggle is off, so a user who
  uninstalls termic mid-experiment can still clean up.
- Wizard: `WelcomeDialog.tsx` is currently three steps (`type Step = 0 | 1 | 2`,
  line 30). Step 0 already detects installed CLIs, so the hooks step can list
  exactly the detected ones rather than a hardcoded list. Adding a step means
  updating the `Step` type, the dot indicators, and the "N of 4" copy.
- Copy rule: **no em dashes** anywhere in this UI.

## Phase 2: opencode

Not a spawned hook: a JS/TS module loaded **in-process**, exporting an async
function that returns handlers. Install to `~/.config/opencode/plugins/`.

Measured cycle, the most complete of any agent:

| termic edge | event | measured |
|---|---|---|
| working | `chat.message` | +23ms after submit |
| attention | `event.permission.asked` | +6ms after `tool.execute.before` |
| attention cleared | `event.permission.replied` | +9ms after the answer |
| done | `event.session.idle` | precise, once per turn |

`permission.replied` is the edge no other agent provides.

Three traps, all measured:

- **Both `.opencode/plugin` and `.opencode/plugins` are loaded.** Writing both
  double-fires every event. Use `plugins` and never write both.
- The global dir already holds the user's `package.json`, `node_modules` and
  `opencode.jsonc`. Live alongside them; do not own the directory.
- **In-process means the safety model inverts.** There is no timeout and no exit
  code. A throw in `tool.execute.before` blocks the tool (opencode's own
  documented example). Wrap every handler in its own try/catch.

opencode has no OSC busy/idle signal (its title is a constant, later the session
name), so it needs a real transport. Being in-process, the plugin can hold one
open connection rather than paying a spawn per event.

## Testing

All three are required before this lands, per `CLAUDE.md`.

**Rust unit tests** on the config writer:

- install into an empty config
- install into a config that already has user hooks (they survive verbatim)
- install twice (idempotent, no duplicate entry)
- install over an older schema version (replaced, not appended)
- remove (file byte-identical to the pre-install original)
- remove when the user hand-edited our entry (left alone)
- malformed JSON input (no write, error surfaced)
- unknown top-level keys round-trip unchanged
- Docker target writes the CONTAINER path, host target writes the host path
- a cloned agent resolves its own dir but claude's schema shape

**TS unit tests**: the emitted OSC body does not match
`BUILTIN_NOTIFY_IGNORE.claude`, and `notificationWantsAttention("claude", body)`
returns true for it. This is the one-line regression that would silently disable
the whole feature.

**e2e spec** (`e2e/specs/`, per the `e2e` skill): toggle on, assert the config
diff against a fixture HOME, feed the OSC through a PTY and assert the attention
badge reaches the DOM without a preceding done, toggle off, assert clean restore.
Add the row to `docs/e2e-coverage.md`.

**Manual**, because no suite catches it: confirm that a real permission prompt no
longer produces a "done" badge one second before the "needs you".

## Traps, all measured

- **`async: true` silently drops `terminalSequence`.** No OSC, no error.
- **`SubagentStop` fires ~1.8s after every `Stop`** for Claude's internal
  follow-up-suggestion agent, with `agent_type: ""` and a message unrelated to
  the turn. `SubagentStart` never fires at all. Filter `agent_type !== ""` if it
  is ever used.
- **`Notification` is a +6.0s nudge, not an edge.** Do not use it as the
  attention signal.
- **`PermissionRequest` means "a decision is required", not "the human is
  blocked".** With Codex's `approvals_reviewer = guardian_subagent` it fired and
  auto-resolved in 3s with nobody involved; Claude's auto mode is likely the
  same. Consider a short debounce before raising attention, cancelled if the
  request resolves.
- **Documented Claude payload fields that do not exist**: `stop_reason`,
  `turn_number`, `session_start_reason`, `user_prompt`. The real names are
  `source`, `prompt`, `prompt_id`. `Stop` also carries undocumented
  `background_tasks`, `session_crons`, `effort`, `permission_mode`.
- **Neither Claude nor Codex emits `OSC 9;4` any more**, across ten captures
  including a 150s run. Do not restore anything that depends on it.
- **Interrupts fire no hook at all.** ESC mid-turn produced no `Stop` on either
  agent, only an OSC title change. OSC stays authoritative; hooks add precision,
  never correctness.
- **The prose-question gap closes on no agent.** Asked to pose a question and
  stop, both Claude and Codex fire `Stop` alone, paint the idle glyph, and emit
  nothing for 20s afterwards. Hooks fix the *tool-mediated* asks
  (`AskUserQuestion`, `ExitPlanMode`, permission prompts). Do not claim more.

## Definition of done

1. Toggle off by default; install and remove both work; removal restores the file
   byte-for-byte.
2. A permission prompt raises attention with no preceding false done.
3. A hook fired outside termic (no `TERMIC_TASK_ID`) emits nothing.
4. A hook fired by Grok emits nothing.
5. Sandboxed and Docker tasks behave identically to unsandboxed ones.
6. `npm test`, `cargo test`, `make e2e` green; `docs/e2e-coverage.md` updated.
7. This plan is deleted and anything still true is folded into
   `docs/gotchas.md`, per the docs-tree rule in `CLAUDE.md`.

## Appendix: what was measured

Harness: every documented hook event registered at once against one recorder; the
agent driven in a real PTY with the raw stream tee'd, so hook fires and OSC
transitions share one wall clock. PTY env reproduced `lib.rs:3099-3112` exactly,
including the `TERM_PROGRAM=iTerm.app` spoof.

Versions: Claude Code 2.1.250, Codex 0.142.5, Antigravity 1.1.22,
opencode 1.17.11, Grok 1.0.5.

### Claude Code 2.1.250

| edge | event | measured |
|---|---|---|
| working | `UserPromptSubmit` | +6..30ms after Enter, once per turn |
| attention | `PermissionRequest` | +20..450ms after `PreToolUse`; `tool_name` splits permission / `AskUserQuestion` / `ExitPlanMode` |
| done | `Stop` | 12ms **before** the OSC idle title |
| still working | `Stop.background_tasks` non-empty | `[{id,type,status,description,command}]` |

Never fired despite being registered: `Setup`, `SessionEnd`,
`UserPromptExpansion`, `StopFailure`, `PermissionDenied`, `PostToolUseFailure`,
`SubagentStart`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `ConfigChange`,
`InstructionsLoaded`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate`,
`WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`,
`ElicitationResult`. Some need a scenario that was not run (compaction, rate
limit). Do not assume they are dead.

### Codex 0.142.5 (measured, then dropped)

`PermissionRequest` at +12ms after `PreToolUse`, `Stop` with
`last_assistant_message`, `SessionStart` at the FIRST TURN rather than launch,
`UserPromptSubmit` carrying `turn_id`.

Dropped because its title already says `[ ! ] Action Required | proj` at +22ms,
its prose-question gap is unfixable by hooks (no ask-tool, so no
`PermissionRequest`, and `Stop` carries no question marker), and its install cost
is the highest measured: a blocking trust modal keyed on a hash of the hook
definition (so every revision re-prompts every user), visible
`Running SessionStart hook` in the TUI every turn, and a schema strict enough
that the `description` key from its own published docs rejects the whole file.

Its work-state problem was a title-pattern problem and is already fixed
(`lib/agents.ts`, `docs/gotchas.md`).

### Antigravity 1.1.22

Loads a hook config and never invokes it. `loaded 1 named hooks from 1 hooks.json
file(s)` and zero fires, across both config locations, both inner-key spellings
(`handlers` and `hooks`), matcher `"*"` and `""`, headless and TUI, and turns
with and without tools. An invalid handler `type` drew no complaint either,
though the binary carries `unsupported hook type`.

Doc errors found: the global path is `~/.gemini/antigravity-cli/hooks.json`, not
the documented `~/.gemini/config/`; and `Stop`'s `decision` is a strict enum
`stop|continue|block`, not "any value other than continue". Both `PreToolUse` and
`Stop` require a `decision`, so an adapter there can never be a pure observer.

Emits no OSC at all.

### Grok 1.0.5

Reads the global `~/.claude/settings.json` (see the Grok guard). Its own
`Notification` fires the moment it blocks, with
`message="Plan approval requested"` and no 6-second delay.

Its titles are rich but must not be trusted alone:

```
grok                                       idle
SPIN - Waiting for response... - grok      busy (waiting on the MODEL, not you)
SPIN - Thinking - grok                     busy
SPIN - Writing file... - grok              busy
Exact One Word Pong Reply Request - grok   idle, with a summary
```

`Waiting for response...` means waiting for the model, so reusing codex's
`\b(Waiting|Action Required)\b` attention pattern would badge needs-you every
turn. Worse, **when grok blocks on plan approval its title freezes on a busy
spinner**: measured at 217 seconds on one frame with no idle transition. Adding
busy/idle title patterns without also taking grok's `Notification` hook would
recreate the Codex latch. **The two must land together or neither.**

Today grok is signal-silent to termic, so byte-quiet fires with `fallbackReason`
of `attention`: imprecise, never stuck, and accidentally right while blocked.

### opencode 1.17.11

See "Phase 2".
