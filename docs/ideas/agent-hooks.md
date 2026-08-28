# Agent lifecycle hooks (measured)

**Status: measured, not approved.** The measurement this doc used to ask for has
been run. Everything below is what a real PTY driving real agents produced on
2026-08-28, against Claude Code 2.1.250 and Codex 0.142.5. The earlier version of
this doc was written from vendor documentation and got enough wrong that its
conclusions did not survive contact with the CLIs.

Method: every
documented hook event registered at once against one recorder, the agent driven
in a real PTY with the raw stream tee'd, so hook fires and OSC transitions share
one wall clock. PTY env reproduces `lib.rs:3099-3112` exactly, including the
`TERM_PROGRAM=iTerm.app` spoof.

## What the measurement changed

The previous draft was wrong on five points that mattered:

1. **`Stop.stop_reason` does not exist.** The auto-resume-on-usage-limit payoff
   (#256) was built entirely on it. The real carrier is `StopFailure`, with
   matchers `rate_limit` / `overloaded` / `authentication_failed`. Separately,
   Claude now ships its own quota auto-resume (`Notification` types
   `quota_auto_resume_fired` / `_stale` / `_disabled`), which reframes #256
   again.
2. **`Notification` is not the attention edge.** It is a nudge that arrives
   6.0 seconds after the agent actually blocks. `PermissionRequest` is the edge,
   at +20ms.
3. **Claude no longer emits `OSC 9;4`.** Zero across ten captures including a
   150-second run. The doc's premise that "OSC detection works today" is only
   half true: the OSC 0 *title* works, the progress protocol is gone.
4. **`SubagentStop` is a trap.** It fires ~1.8s after every `Stop` for Claude's
   internal follow-up-suggestion agent, with `agent_type: ""` and a message
   unrelated to the turn. `SubagentStart` never fires at all.
5. **Codex hooks cannot be installed silently.** They trigger a blocking trust
   modal, and do not run until the user clears it.

The doc's two settled constraints survived and are now evidence-backed: OSC stays
authoritative, and hook-derived state must not latch.

## The headline result: every agent fails differently

This is the finding the whole design turns on, and neither vendor doc implies it.

**Claude's title lies about being blocked.** When Claude stops for a permission
prompt, a question, or plan approval, it paints its *idle* glyph:

```
29.774  HOOK  PreToolUse         tool_name=Write
29.787  OSC   0;✳ Create out.txt file    <- idle glyph. Agent is BLOCKED.
29.807  HOOK  PermissionRequest  tool_name=Write
35.830  HOOK  Notification       notification_type=permission_prompt
35.831  OSC   9;Claude needs your permission   <- termic's first honest hint
```

With `SETTLE_MS` at 5s, termic fires a **false "done"** at +5s and only corrects
to "needs you" at +6s. Two notifications for one event, the first one wrong.

**Codex's title tells the truth.** When Codex genuinely blocks on a human it sets
`[ ! ] Action Required | proj`, which termic's existing `attention` pattern
already matches, 22ms after the block:

```
37.412  HOOK  PreToolUse
37.424  HOOK  PermissionRequest              (+12ms)
37.434  TITLE '[ ! ] Action Required | proj' (+22ms)  <- termic already sees this
```

So **hooks are essential for Claude and marginal for Codex.** For Claude they are
the only signal that does not lie. For Codex they buy 10ms and a `tool_name`.

Measuring the other two first-class agents turned that pair into a four-way
spread, and the spread, not the event tables, is what should drive the plan:

| agent | attention signal today | what hooks add |
|---|---|---|
| Claude | title LIES (paints idle), OSC 9 notify 6.0s late | the whole thing |
| Codex | title says `Action Required`, +22ms | nothing it does not already have (see below) |
| opencode | nothing at all (static title) | the whole thing, cleanest API, and the only `attention cleared` edge |
| Antigravity | nothing at all (no OSC whatsoever) | nothing: it loads hooks and never runs them |

The value is concentrated in Claude and opencode, and those two happen to be the
two cheapest to build: Claude needs no IPC at all (`terminalSequence`), opencode
is already in-process. Codex, the agent the previous draft ranked second, is the
one with the least to gain and the highest install cost (a blocking trust modal
that re-prompts on every hook-set change).

Codex's real defect was elsewhere and was not a hook problem at all: it dropped
the status words its built-in title patterns were written for, so its idle title
classified as null, `senderStateRef` latched to `busy`, and every demoter is
gated on `!senderBusy`. Codex tabs went "working" on the first turn and never
came back. Fixed in `lib/agents.ts` + the submit gate in `TerminalPane`, see
`docs/gotchas.md`. **A pattern fix, not a hook.** Worth remembering before
reaching for hooks again: check whether the agent already says it.

## Claude Code 2.1.250: the manifest

Four registrations. All `type: "command"`, all once per turn, none per tool call.

| termic edge | event | measured |
|---|---|---|
| working | `UserPromptSubmit` | +6..30ms after Enter. `prompt`, `prompt_id`. |
| attention | `PermissionRequest` | +20..450ms after `PreToolUse`. `tool_name` splits the kind. |
| done | `Stop` | fires **12ms before** the OSC idle title. `last_assistant_message`, `background_tasks`. |
| correlation | `SessionStart` | `session_id`, `cwd`, `model`, `source`. |

`PermissionRequest.tool_name` is what splits the two attention states the old doc
wanted `notification_type` for, and it splits them three ways rather than two:

- `Write` / `Edit` / `Bash` / ...: blocked on a permission decision
- `AskUserQuestion`: blocked on a question
- `ExitPlanMode`: blocked on plan approval

A `Stop` whose `background_tasks` array is non-empty is **not** done: the shape is
`[{id, type, status, description, command}]`, and it is how to avoid the
"done badge held for 617s while three subagents ran" failure `gotchas.md`
already documents from the other side.

**Do not register:** `SubagentStop` unfiltered (phantom, see above; filter
`agent_type !== ""`), `Notification` as the attention edge (+6.0s), any of
`PreToolUse` / `PostToolUse` / `PostToolBatch` (one process spawn per tool call),
`idle_prompt` (90s at an empty prompt produced nothing).

**Never fired in any scenario**, despite being registered: `Setup`,
`SessionEnd`, `UserPromptExpansion`, `StopFailure`, `PermissionDenied`,
`PostToolUseFailure`, `SubagentStart`, `TaskCreated`, `TaskCompleted`,
`TeammateIdle`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`,
`DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`,
`PostCompact`, `Elicitation`, `ElicitationResult`. Some of those need a scenario
we did not run (compaction, rate limit); do not assume they are dead.

### Payload corrections against the published docs

| Field | Documented | Actual |
|---|---|---|
| `SessionStart` reason | `session_start_reason` | `source` |
| `UserPromptSubmit` text | `user_prompt` | `prompt` |
| turn number | `turn_number` | absent; `prompt_id` instead |
| `Stop` reason | `stop_reason` | does not exist |
| `PostToolUse` | - | `duration_ms` (undocumented) |
| `Stop` | - | `background_tasks`, `session_crons`, `effort`, `permission_mode` |

## Codex 0.142.5 (measured, then dropped)

Kept for reference only; see the decision below.


| termic edge | event | measured |
|---|---|---|
| working | `UserPromptSubmit` | carries `turn_id` (Claude's is `prompt_id`) |
| attention | `PermissionRequest` | +12ms after `PreToolUse`. `tool_name`, `tool_input`. |
| done | `Stop` | `last_assistant_message`, `stop_hook_active` |
| correlation | `SessionStart` | fires at the FIRST TURN, not at launch |

Three things the vendor doc does not tell you, each of which changes the design:

- **The trust modal.** Installing `~/.codex/hooks.json` makes Codex open a
  blocking modal on next launch: *"Hooks need review / N hooks are new or changed
  / Hooks can run outside the sandbox after you trust them"*, with `1. Review
  hooks  2. Trust all and continue  3. Continue without trusting (hooks won't
  run)`. Until cleared, hooks do not run. Trust is keyed on a hash of the hook
  definition, so **every change to our hook set re-prompts every user.**
  `--dangerously-bypass-hook-trust` exists but is for automation, not for us.
- **The schema is strict.** An unknown top-level key rejects the whole file with
  a visible `failed to parse hooks config` warning. The `description` key shown
  in the published docs is one such key. A merge writer must not round-trip
  unknown keys into this file.
- **TUI noise.** Codex renders `• Running SessionStart hook` in its status line
  while a synchronous hook runs. Every turn, visible to the user.

No `SessionEnd`, `PreCompact`, `PostCompact`, `SubagentStart` or `SubagentStop`
fired in any scenario.

## Antigravity 1.1.22: documented, loaded, never invoked

Measured because `agy` is a first-class agent here and its hook doc reads as the
most capable of the three. The result is a warning about the whole "just add an
adapter" plan.

`agy` **loads** a hook config and then never runs it. Across six attempts it
logged `loaded 1 named hooks from 1 hooks.json file(s)` and fired nothing:

- both config locations: `<workspace>/.agents/hooks.json` and the global path
- both inner-key spellings: `handlers` and `hooks`
- matcher `"*"` and `""`
- headless `--print` and the interactive TUI
- turns that used tools and turns that did not

A deliberately invalid handler `type` drew no complaint either, even though the
binary carries `unsupported hook type: %q`. So the outer object parses and the
handler entries never reach the type check. The most likely reading is that hooks
are an Antigravity IDE feature whose config the CLI loads for parity without
executing, but that is inference, not measurement. Worth a re-test on a newer
`agy`, or a check by someone running the IDE.

Two documentation errors found on the way, both verifiable in the binary:

- The global config path is `~/.gemini/antigravity-cli/hooks.json`, not the
  documented `~/.gemini/config/`. Workspace-local `<workspace>/.agents/hooks.json`
  is real but only loads for a trusted folder.
- `Stop`'s `decision` is a strict enum, `stop|continue|block`, described in the
  binary as "'stop' to allow termination, 'continue' or 'block' to continue
  execution". The published doc says any value other than `continue` allows the
  stop, which would make a passive observer that returns nothing a coin flip.
  `PreToolUse` is `allow|deny|ask|force_ask|deny_unless_prior_grant`.

Both `PreToolUse` and `Stop` document `decision` as **required**, so an adapter
here can never be a pure observer: it has to assert `allow` and `stop` on every
call, and a hook that crashes or times out is then deciding agent behaviour by
omission. That alone makes Antigravity a poor second agent even if the CLI starts
honouring hooks.

`agy` also emits **no OSC at all**: no title, no `9;4`, no `133`. It is the
signal-silent case `TerminalPane` already names, where `senderStateRef` stays
null and the demoters downgrade their verdict from `done` to `attention`.
Antigravity is therefore the one agent where hooks would add the most and the one
where they currently work the least.

## opencode 1.17.11: the cleanest surface of the four

Not a spawned hook at all: a JS/TS module loaded in-process, exporting an async
function that returns handlers. That makes it the odd one out architecturally and
the best one behaviourally. Measured with a project-local plugin, so nothing of
the user's config was touched.

The full blocked cycle, which no other agent gives completely:

```
 34.172  tool.execute.before
 34.178  event.permission.asked      <- attention, +6ms
122.673  user answers (89s blocked)
123.271  event.permission.replied    <- attention CLEARED, +9ms
123.277  tool.execute.after
131.428  event.session.idle          <- done
```

| termic edge | event | measured |
|---|---|---|
| working | `chat.message` | +23ms after submit |
| attention | `event.permission.asked` | +6ms after `tool.execute.before` |
| attention cleared | `event.permission.replied` | +9ms after the answer |
| done | `event.session.idle` | precise, once per turn |

`permission.replied` is the one thing every other agent lacks. Claude and Codex
force us to infer "the user answered" from the next tool call or the next busy
title; opencode says it. Also available and unmeasured here: `session.error`,
`session.compacted`, `session.status`, `file.edited`, `todo.updated`.

opencode emits **no busy/idle OSC**: its title is a constant (`OpenCode`) that
later becomes the session name (`OC | Create out.txt containing hi`). It is not in
`BUILTIN_TITLE_SIGNALS`, so `classifyAgentTitle` returns null, `senderStateRef`
stays null, and termic falls back to byte-quiet with `fallbackReason` of
`attention`. So like Claude, and unlike Codex, a plugin is a large upgrade here.

Three implementation notes that cost real time to find:

- **Both `.opencode/plugin` and `.opencode/plugins` are loaded.** Installing to
  both double-fires every event. Measured, not guessed. Use `plugins` (the
  documented spelling) and never write both.
- Global is `~/.config/opencode/plugins/`, which on a real machine already holds
  `package.json`, `node_modules` and `opencode.jsonc`. An installer has to live
  alongside those, not own the directory.
- The plugin runs **in-process**, so the safety model inverts. There is no
  timeout and no exit code: a throw inside `tool.execute.before` blocks the tool
  (that is opencode's own documented example for it), and an unhandled throw
  anywhere lands inside opencode's runtime rather than in a child process we can
  ignore. Every handler must be individually wrapped, and none may be async in a
  way that opencode awaits before proceeding.

Being in-process is also an opportunity the spawned agents do not have: the
plugin can hold one open connection rather than paying a process spawn per
event.

## Decision: Codex is out of scope

Dropped on the evidence, not to save effort. Three measurements, and the
third is the one that settles it.

**Tool-mediated blocks are already covered.** Codex sets
`[ ! ] Action Required | proj` 22ms after blocking, which
`BUILTIN_TITLE_SIGNALS.codex` already matches. `PermissionRequest` beats it by
10ms and adds a `tool_name` nobody has asked for.

**Prose questions are covered by nothing, including hooks.** Asked to pose a
clarifying question and stop, Codex's title goes to the bare idle form and stays
there. No `Action Required`, and no hook can rescue it: Codex has no ask-tool, so
no `PermissionRequest` fires, and its `Stop` carries `last_assistant_message` and
`stop_hook_active` with nothing marking the message as a question. Installing
hooks would not close the one gap Codex still has.

**The install cost is the highest of any agent.** A blocking trust modal keyed on
a hash of the hook definition, so every revision re-prompts every user; visible
`• Running SessionStart hook` noise in the TUI on every turn; and a schema strict
enough that one unknown key rejects the whole file.

So Codex is the only agent measured where hooks cost the most and close nothing.
Its work-state detection is a title-pattern problem, and that problem is fixed
(`lib/agents.ts`, `docs/gotchas.md`).

### The gap hooks do not close, on any agent

Claude behaves identically in the prose case: asked to ask a question and stop, it
fired `Stop` alone, painted its idle glyph, and produced no `PermissionRequest`
and no `Notification` for the 20 seconds that followed. The only handle is that
`last_assistant_message` happens to end in a question mark, which is a heuristic,
not a protocol.

What hooks fix for Claude is the **tool-mediated** case, which is genuinely broken
today: `AskUserQuestion`, `ExitPlanMode` and ordinary permission prompts all
paint the idle glyph while blocked. That is the claim to make, and it is narrower
than "hooks tell us when the agent needs you". opencode is the only agent
measured that reports both the block and its release outright.

## Grok: unmeasured, but it reads Claude's config

`grok` is not installed on the machine the rest of this doc was measured on, so
none of the following is verified. It is recorded because one line of its
documentation bears directly on the Claude-only v1, whether or not termic ever
supports Grok.

Per [the xAI docs](https://docs.x.ai/build/features/hooks), Grok's hook config
lives at `~/.grok/hooks/*.json` and `<project>/.grok/hooks/*.json`, and it
**also reads `.claude/settings.json` and `.cursor/hooks.json`**.

That is a hazard for us, not a feature. If it includes the GLOBAL
`~/.claude/settings.json` (the doc writes the path without a `~/`, so this is
genuinely ambiguous and is the thing to measure first), then installing hooks for
Claude silently installs them for Grok too, on every machine where both are
present. Consequences, in order of how much they would hurt:

- Our callback would be invoked by an agent whose payload is **camelCase**
  (`hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `toolName`,
  `toolInput`), not Claude's snake_case. A normaliser written against Claude
  alone reads every field as undefined.
- Our Claude transport is `terminalSequence`, a Claude-specific output key.
  Grok's documented output contract is `{"decision": ..., "reason": ...}` with
  exit 0 allow / exit 2 deny. An unrecognised key is *probably* ignored, but
  "probably" is doing a lot of work in a path that can block a tool call.
- The user consented to termic writing Claude's config. They did not consent to
  it changing Grok's behaviour, and the Settings pane would not list Grok as
  installed.

The clean discriminator already exists: Grok exports `GROK_HOOK_EVENT`,
`GROK_HOOK_NAME`, `GROK_SESSION_ID` and `GROK_WORKSPACE_ROOT` into the hook
process. A callback should check for those and bail rather than assume it was
called by Claude. That check is cheap and should go in from the start, before
anyone confirms whether the global file is read.

Two further notes if Grok is ever measured properly. It has **no
`PermissionRequest`**, only `PermissionDenied` and `Notification`, so its
attention edge would rest on `Notification`, which on Claude we measured as a
6.0s-late nudge rather than an edge. And `PreToolUse` is documented as "the only
blocking event", which is a safer contract than Antigravity's.

## Interrupts: why OSC stays authoritative

Escape during an active turn produced **no `Stop`** on either agent. Claude's
title went to `✳`, Codex's went to `proj`, and no hook fired at all. Codex also
left a dangling `PreToolUse` with no matching `PostToolUse`.

This is the evidence for the constraint the old doc asserted: hooks add
precision, never correctness. A hook-only work-state model would leave an
interrupted turn stuck "working" forever.

## Transport

**Claude: no IPC needed.** A Claude hook's stdout JSON may carry
`terminalSequence`, which Claude writes to its own PTY. Verified end to end:
`OSC 9;4;3`, `OSC 9;4;0` and `OSC 777;notify;...` all landed in the stream
verbatim, 6-8ms after the hook fired, and termic's existing handlers already
parse all three. Allowlist, quoted from the binary: *"only OSC 0/1/2/9/99/777 and
BEL are permitted, and OSC 9 bodies may not begin with a digit unless in the 9;4
progress form"*.

This dissolves the entire transport section of the previous draft. No socket, no
`termic hook` binary on the host, no Seatbelt grant, no Docker plumbing, no
per-task token, because the channel is the PTY the agent already owns. It works
identically unsandboxed, under Seatbelt and in Docker, for free.

**The one constraint: it requires a synchronous hook.** With `async: true` the
sequence is silently dropped (measured: no OSC at all). Affordable here, because
the manifest is four once-per-turn events and a static callback is ~2ms. It would
not be affordable with a per-tool-call hook, which is a second reason not to
register one.

**Codex: no equivalent.** Its hook output schema has `systemMessage`,
`additionalContext`, `suppressOutput` and `hookSpecificOutput`, and no
terminal-writing field. Codex therefore needs a real transport if we ever want
its hooks, which is a further reason to treat Codex as phase 2 given how little
its hooks add over the title it already paints.

## Correlation

`TERMIC_TASK_ID` is already injected into every agent PTY (`lib.rs:3079`), and
the comment there states it reaches every child, caged included. That is an exact
O(1) key: no cwd matching, and it disambiguates two agents in one worktree, the
case the previous draft flagged as unsolvable. If it is absent the hook was not
spawned by a termic PTY: drop the event rather than guess.

For the `terminalSequence` route correlation is free anyway, because the sequence
arrives on the tab's own PTY.

## Sandbox

The previous draft spent a long section on this and it is now mostly moot.

- **Seatbelt.** Nothing to grant. The hook writes to its own stdout; the
  agent's config dir is already readable in the cage and `(allow process-exec)`
  is already unconditional (`sandbox.rs:1826`). The control socket stays denied,
  as `docs/plans/cli.md` settled.
- **Docker.** The agent config dir is `<data_dir>/docker-agents/<agent_id>/`
  (`docker.rs:349`), which termic owns. Writing hooks there mutates nothing of
  the user's, so it needs no consent step and can be on by default. Note the
  clone trap: the path is keyed on the agent's OWN id while the schema shape
  comes from `base_agent_id`.
- **Linux.** No Seatbelt exists (`sandbox.rs` has no `cfg(target_os)`); Docker is
  the Linux cage. Config paths are the same `~/.claude` and `~/.codex`.

## Settings and wizard

Off by default, one toggle, explicit uninstall, files listed before writing, not
after. Per-agent state shown the way Settings → Coding Agents already lists
detected CLIs.

The wizard step lists only the agents it can actually deliver, which after the
measurement is Claude and opencode. Xirp's equivalent step promises "hooks wired
up" for Claude, Codex and Gemini; for Codex that cannot be true without the user
clearing a trust modal inside Codex first, and Codex gains nothing from hooks
anyway. Listing an agent we did not wire, or wired ineffectively, is the failure
mode to avoid here.

Say what is being installed and where, before writing rather than after, and
show per-agent state the way Settings → Coding Agents already lists detected
CLIs. An agent that is installed but detected as unsupported (Antigravity today)
should say so rather than appear wired.

Copy rule: no em dashes.

## Phasing

1. **Claude only, `terminalSequence` route.** Four events, synchronous, writing
   OSC into the tab's own PTY. No new binary, no socket, no sandbox change. This
   is where nearly all the value is, and it is the cheapest thing in this doc.
2. Consume the richer payload where it needs more than an OSC can carry:
   `last_assistant_message` for auto-titles, `background_tasks` for the
   done-vs-still-working split, `PermissionRequest.tool_name` for the three-way
   attention state.
3. **opencode**, via its plugin API. Second-largest gain, no config-file merge
   problem, and the only agent that reports `permission.replied`, so it is where
   the attention state can be made exactly right rather than approximately.
4. Codex: **not planned.** See "Decision: Codex is out of scope" above.
5. Antigravity is measured and currently unusable (above). Grok is unmeasured
   but carries a hazard the Claude work must handle from day one (above).
   Gemini, Copilot and Cursor remain entirely unmeasured; the old vendor-doc table was wrong
   often enough for the four agents that WERE measured that it should not be
   trusted for any of them.

## Still unknown

- `StopFailure` and the rate-limit path (never triggered).
- Compaction (`PreCompact` / `PostCompact`) on either agent.
- `SessionEnd` on either agent; Ctrl-D produced neither the hook nor a PTY EOF.
- Whether `PermissionRequest` means "the human is blocked" or only "a permission
  decision is required". With Codex's `approvals_reviewer = guardian_subagent` it
  fired and then auto-resolved in 3s with no human involved. Claude's auto mode
  is likely the same. A short debounce before raising attention, cancelled if the
  request resolves, is probably needed.
- Why `agy` loads a hook config it never invokes, and whether a newer build or
  the Antigravity IDE runs them.
- Whether Grok reads the GLOBAL `~/.claude/settings.json` or only a project-local
  `.claude/settings.json`. This decides whether a Claude install silently becomes
  a Grok install. Needs `grok` on a machine to answer.
- Gemini, Copilot and Cursor: entirely unmeasured.
- opencode's `session.error`, `session.compacted` and `session.status`, and
  whether an in-process plugin can hold one open connection rather than paying a
  spawn per event.
