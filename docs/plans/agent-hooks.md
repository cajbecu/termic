# Agent lifecycle hooks

**Approved, ready to implement.** Everything here is measured against live CLIs
on 2026-08-28, not read from vendor documentation. Every vendor doc consulted was
wrong about something load-bearing, so treat the appendix as the source of truth
and re-measure before trusting any statement about an agent not listed there.

## What to build

Install one hook per state an agent's terminal reports WRONG, into that agent's
own global config, so termic stops guessing. Off by default, behind a per-agent
Settings toggle with a working uninstall, plus a wizard step.

Four agents ship: claude, grok, agy and opencode. Each reports a different set,
because each terminal is wrong in a different way; see "What each agent reports".
Codex is out of scope on evidence: its terminal is already right.

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
| Claude Code | **shipped** | Its title claims IDLE while blocked, so the hook is a correction, not an addition. |
| opencode | **shipped** | No busy/idle OSC at all, and the only agent that reports `permission.replied`, so its attention can be cleared exactly. |
| Codex | no | Its title already says `Action Required` at +22ms. Hooks add 10ms and cost a blocking trust modal that re-prompts on every hook-set change. |
| Grok | **yes, shipped** | Its title FREEZES on a busy spinner while blocked (measured, 217s on one frame), so `Notification` is the only signal that state has. The guard against our claude hook firing under grok is still mandatory. |
| Antigravity (`agy`) | **shipped** | No attention event exists, so it reports working and done instead. It emits no OSC at all, so that is a large upgrade: every turn used to end in the byte-quiet fallback's orange bell. |
| Gemini, Copilot, Cursor | no | Unmeasured. Do not write adapters from their docs. |

## Global installs only. No exceptions.

**termic never writes a project-level hook config, for any agent, ever.** Every
install target below is a global, per-user path (or, for Docker, a termic-owned
per-agent path). This is a rule, not a default, and every reason for it was
measured:

- **Double-firing.** Grok with both a global Claude file and a project
  `.grok/hooks/*.json` fired every event exactly twice (24 and 24). opencode
  loads BOTH `.opencode/plugin` and `.opencode/plugins`, so writing both
  double-fires there too. Two config layers is two of every signal.
- **It pollutes the user's repo.** `.claude/settings.json`, `.grok/hooks/`,
  `.agents/hooks.json` and `.opencode/plugins/` are not reliably gitignored, so
  they surface as untracked files in termic's own diff pane on every task.
- **Symlinks defeat the scoping anyway.** termic symlinks repo-root `.claude`
  and friends into each new worktree, so a write into a worktree's `.claude`
  travels back into the user's real repo.
- **It does not cover every task.** Repo-root tasks and non-git projects have no
  worktree to scope to, so the global path is needed regardless. Two mechanisms,
  one of which is the dangerous one, is worse than one.
- **Project scope is unreliable.** Antigravity's `<workspace>/.agents/hooks.json`
  and Grok's project sources both require the folder to be trusted first, so a
  project install silently does nothing until the user clears an unrelated
  prompt.

Docker is not an exception to this. Its target is
`<data_dir>/docker-agents/<agent_id>/`, which is per-AGENT and termic-owned, not
per-project.

## The design, using claude as the worked example

### Why claude gets exactly one event

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

### The transport for every agent that is not claude

`terminalSequence` is claude's alone. No other agent has such a field, so the
hook has to put the sequence on the terminal itself, and the obvious route does
not work:

- **`/dev/tty` fails.** Measured on grok 1.0.5: the hook fires, and the write
  returns `rc=1`. Hooks run with no controlling terminal, so there is no
  `/dev/tty` to open. Do not "fix" this by retrying or by using `tty`.

What does work is handing over the path. termic owns the pty, so it resolves the
slave device with `ptsname(master_fd)` and injects it as **`TERMIC_PTY`** at
spawn (`lib.rs`, next to the `TERM_PROGRAM` spoof). The hook then writes:

```sh
[ -n "$TERMIC_PTY" ] || exit 0
printf '\033]777;notify;termic;agent needs your input\007' > "$TERMIC_PTY" 2>/dev/null
```

Opening a tty BY NAME needs no controlling terminal, which is exactly why this
works where `/dev/tty` does not. Measured end to end: a grok `Notification` hook
wrote here and the OSC reached termic's parser.

This grants nothing new. The agent already owns that terminal and can write
anything it likes to it; the hook is in the same process tree.

`ptsname` returns a pointer to a static buffer and has no `_r` variant on macOS,
so the call and the copy are both taken under a mutex. Two concurrent spawns
would otherwise read each other's device name, which is the kind of bug that
appears once a month on a busy machine and never in a test.

**claude stays on `terminalSequence`** rather than being moved to the shared
path: claude writes the sequence itself, at a sane point in its own render loop,
where a hook writing concurrently to the pty could in principle interleave with
a frame. Same OSC, same handler, one fewer moving part for the agent that does
not need it.

Docker is the known gap. The container gets its own pty, so a host `TERMIC_PTY`
names a device that does not exist inside the cage; the redirect fails and the
script exits 0. claude keeps working there (its transport is its own stdout),
every other agent silently loses its hook, and that is the honest state until
someone plumbs a container-side path.

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
- **Docker**: a **separate install target**, same agent, same toggle. The config
  dir is `<data_dir>/docker-agents/<agent_id>/` (`docker.rs:349`), which termic
  owns, so writing there mutates nothing of the user's and needs no SEPARATE
  consent. It still follows the agent's switch: a user who declined hooks for
  Claude must not find them installed for Claude-in-Docker. One toggle per
  agent, both targets.
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

The blast radius is wider than just `~/.claude/settings.json`. Grok's shipped doc
lists every compatible source it scans: `~/.claude/settings.json` AND
`settings.local.json`, the project-level `.claude/settings.json` and
`settings.local.json`, and the same pair for `~/.cursor/hooks.json`. Termic
symlinks repo-root `.claude` into each worktree, so a project-level install would
travel too. Install globally only, and keep the script's own gate as the real
defence.

There IS a documented opt-out, worth putting in the Settings copy so a user who
does not want this has an answer: `[compat.<vendor>] hooks = false` in
`~/.grok/config.toml`, or the equivalent environment variable. It is not a
substitute for the gate, because it only helps users who go and set it.

## Settings and wizard

### Per agent, not one master switch

One toggle per agent, never a single "install hooks" button. Not for
granularity's own sake: the consent question is genuinely different per agent.

- **Claude**: a shell script in `~/.claude/termic-hooks/` plus an entry in a
  config file the user already owns. Reversible, inspectable, inert if it fails.
- **opencode**: a JS module that runs IN-PROCESS inside opencode, with no
  timeout and no exit code, where a throw in `tool.execute.before` blocks the
  tool.

Those are not the same ask, and a user can reasonably want the first and not the
second. A single switch would hide the difference.

Each agent's toggle covers BOTH its targets (host and Docker). Off by default.

### The row

Settings, next to `SignalInspector.tsx`, which is already where a user goes when
state detection looks wrong. Four states, and an agent that is installed but not
wired must say so rather than appear wired:

```
claude      Hooks: not installed                             [Install]
opencode    Hooks: installed                                 [Remove]
codex       Hooks: not needed (its terminal already reports this)
agy         Hooks: not supported yet
```

Rules for the pane:

- Name the exact files BEFORE writing, not after.
- "Remove" stays available even when the toggle is off, so a user who uninstalls
  termic mid-experiment can still clean up.
- `disableAllHooks` set in the Claude config means an install would never fire:
  say that instead of reporting success.
- Grok stays out of this list in phase 1. It is not an install, it is a
  suppression, and a row saying "we made sure nothing happens here" invites more
  confusion than it removes. Mention the `[compat.grok] hooks = false` opt-out in
  the help text for users who do not want termic's Claude hook visible to Grok
  at all.

### Wizard

`WelcomeDialog.tsx` is three steps today (`type Step = 0 | 1 | 2`, line 30).
Step 0 already detects installed CLIs, so the hooks step lists exactly the
detected ones rather than a hardcoded set. Adding a step means updating the
`Step` type, the dot indicators, and the "N of 4" copy.

List only agents the step can actually deliver. Xirp's equivalent promises
"hooks wired up" for Claude, Codex and Gemini; for Codex that cannot be true
without the user first clearing a trust modal inside Codex. Claiming an agent we
did not wire is the failure to avoid.

### Later: the earned prompt

Do not nag on install. If a proactive prompt is wanted, make termic earn it: the
false done has an exact signature we can already see, a `done` followed by an
`attention` on the same tab within ~10s. Count it per agent, and after a few
occurrences offer the fix once, with the evidence ("Claude reported finished 4
times today when it was actually waiting for you"). That is a fix offered when
the bug bites rather than a feature advertised. Phase 3 at the earliest.

Copy rule: **no em dashes** anywhere in this UI.

## What each agent reports, and why it differs

One rule decides the set: a hook is registered ONLY for a state the terminal
gets wrong or cannot express. Everything the terminal already says correctly is
left alone, and per-tool-call events are never registered on any agent.

| Agent | Events | Reports | Notes |
|---|---|---|---|
| claude | `UserPromptSubmit`, `PermissionRequest`, `Stop` | working, attention, **done** | Its title claims IDLE while blocked, so attention is a correction. Done comes from `Stop`, which lands ~25ms before that title and gives a HARD done (no 5s settle). |
| grok | `UserPromptSubmit`, `Notification`, `Stop`, `StopCancelled` | working, attention, **done** | Has no `PermissionRequest`, and its title FREEZES on a busy spinner while blocked (217s on one frame, measured). `StopCancelled` makes it the only agent whose done survives an INTERRUPT. |
| agy | `PreInvocation`, `Stop` | working, **done** | Has NO attention-shaped event, so needs-you there stays on the byte-quiet fallback. It emits no OSC at all, so done is a large upgrade. |
| opencode | `chat.message`, `permission.asked`, `permission.replied`, `session.idle` | all four | The only agent that reports the RELEASE of a block, so attention is cleared exactly rather than inferred. |

**Done and attention come from a protocol on every agent that exposes one.**
That is the whole point, and it is a reliability argument, not a latency one:
`Stop` beats the idle title by milliseconds, which is worth nothing on its own.
What it is worth is not depending on a vendor's UI. The Codex latch in
`docs/gotchas.md` is exactly that failure: a title format changed, and done
detection stopped working silently until someone noticed tabs stuck on
"working".

`Working` is registered alongside `Done` on every agent, even where the title
already reports it, so the pair is self-sufficient. `goIdle(reason, 0)` is
ignored unless we were working, so a Done that relied on the title having set
working would inherit exactly the fragility the hook exists to remove.

### Hooks own the turn, so the heuristics stand down entirely

`agentHooksInstalled[cli]` switches off EVERY path that can end a turn for that
agent, not just the title: byte-quiet, scrollback stability, the settled-hash
check, the 90s ceiling and the 10-minute absolute ceiling. They are one
heuristic wearing five hats, and leaving any of them armed reproduces the exact
bug hooks exist to fix. The 8.5-minute run with four real subagents is the
measurement: the agent's own `Stop` correctly stayed silent for all of it,
while the title claimed idle for 30% of the window and the screen sat unchanged
for minutes at a time. A `done` from any of those five is a `done` the agent
never reported.

This trades one failure for another and the direction is deliberate. A dropped
hook now leaves a tab reading "working" until the next prompt, where before a
ceiling would eventually force it to "done". A stuck spinner is cosmetic and
self-heals on the next `UserPromptSubmit`; a false "done" on a task that is
still running is the bug this whole document exists to remove. Fail towards
still-working.

The one exception is an interrupt, below, which is licensed by a keystroke and
clears the working state without claiming a completion.

### Interrupts: the one thing hooks do not cover

Half the supported agents report an interrupt through no channel at all, so
this is the single hole in "hooks own the turn". Measured on every agent, both
keys, against a genuinely foreground generation (a 3000-line count, ~50s, with
the key sent 8s in and 15s of recording after it):

| agent | Escape | Ctrl-C |
| --- | --- | --- |
| claude | **no hook**; idle glyph 110ms later | **no hook**; idle glyph 40ms later |
| grok | `StopCancelled`, `reason="user_interrupt"`, 350ms | `StopCancelled`, same, 40ms |
| agy | **nothing at all**, and no title state either | **nothing at all**, same |
| opencode | **key ignored**, generation continues | `session.error` then `session.idle`, then exits |

claude was measured with 29 of its 31 lifecycle events registered; its event
list, read out of the binary, contains no cancel or abort event to register.
agy's own UI prints "Interrupted", so the turn really did end, and it still
publishes nothing. That is what settles the design: the keystroke has to be
part of the evidence, because for claude and agy there is nothing else.

The keystroke is never enough ALONE. Something has to corroborate it, and
opencode is the reason: it ignores Escape outright and keeps streaming, so a
detector that trusted the key would end a turn that is still running. termic
therefore accepts an interrupt only when the key is followed by one of:

- **the title going idle** (`ESC_INTERRUPT_WINDOW_MS`, 3s) — claude's route,
  and it is prompt: the idle glyph lands 40-110ms after either key.
- **the terminal going quiet** (`INTERRUPT_QUIET_GRACE_MS`, 15s) — agy's only
  route, since it has neither a hook nor a title. An agent that ignored the key
  keeps painting, so quiet never arrives and nothing fires.

Both are gated on the user actually watching the tab, and both call
`interruptWork`, not `fireDone`: an interrupt is not a completion, so it earns
no badge, no bell, and does not spend the one-done-per-submit token.

An earlier revision of this doc said the title alone covered this and no
keystroke handling was needed. That held for claude and was wrong for agy,
which has no title to read.

### Three config shapes, not one

- **Claude-compatible** (`claude`, `grok`): `hooks.<Event>[] = { hooks: [handler] }`.
  Not a coincidence that grok matches: it reads claude's file on purpose.
  claude merges into the shared `settings.json`; grok gets its own
  `~/.grok/hooks/termic.json`, so its removal is a delete.
- **Antigravity named** (`agy`): one top-level entry we own outright at
  `~/.gemini/config/hooks.json`, and HETEROGENEOUS inside it. Tool events take a
  `{matcher, hooks}` group; `PreInvocation` / `PostInvocation` / `Stop` take
  handlers DIRECTLY. Wrap the latter and they register with an EMPTY command:
  visible in `agy -p "/hooks"`, and inert.
- **opencode plugin**: a JS module at `~/.config/opencode/plugins/termic.js`.
  No merge, nothing of the user's to preserve. It runs IN-PROCESS, so there is
  no timeout and no exit code and a throw in `tool.execute.before` blocks the
  tool: every handler is individually wrapped.

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
- every install target resolves to a GLOBAL or termic-owned path: no target may
  ever resolve under a task's worktree or repo root (the one test that pins the
  "global installs only" rule mechanically rather than by review)

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

## Before writing any adapter: ask the binary, not the website

This plan was corrected three times because a vendor website was trusted over
the installed CLI. The order that actually works:

1. **Look for shipped docs.** Grok carries a 42KB
   `~/.grok/docs/user-guide/10-hooks.md`, version-matched to the binary, with a
   full event table and a "differences from Claude" section. It is far better
   than the website and reading it would have saved hours.
2. **Ask the CLI what it resolved.** `agy -p "/hooks"` prints the command it
   resolved per event, so an empty column tells you the schema is wrong before
   you spend a turn wondering why nothing fired. Codex has `/hooks` too.
3. **Read the changelog.** `agy changelog` is what revealed that
   `~/.gemini/antigravity-cli/hooks.json` is a path they FIXED, which is why a
   config there loads and never executes.
4. **Only then** the website, and only as a hypothesis to test.

The failure mode is not "docs lie". It is subtler: a config that PARSES is not a
config that RUNS, and both Antigravity and Grok will happily report a hook as
loaded while it is inert or pointed at a dead path.

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
- **Interrupts fire no hook on Claude, Codex or agy.** ESC mid-turn produced no
  `Stop` on either, only an OSC title change, so OSC stays authoritative for
  those two: hooks add precision, never correctness. **Grok is the exception**
  and has a dedicated `StopCancelled` (measured, `reason="user_interrupt"`,
  435ms after the key). Do not generalise either way across agents.
- **A hook config can LOAD and still never run.** Antigravity accepts one at
  `~/.gemini/antigravity-cli/hooks.json`, logs `loaded 1 named hooks`, and
  executes nothing, because that path is desynchronised from its backend; the
  live path is `~/.gemini/config/hooks.json`. Never treat "the agent parsed my
  config" as "the agent will run it". Ask the agent what it resolved
  (`agy -p "/hooks"`) and check the command column is non-empty.
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
5. No project-level config is written, for any agent, ever. Grep a task's repo
   after an install: it must be untouched.
6. Each agent has its own toggle, and it covers that agent's host AND Docker
   targets together.
7. Sandboxed and Docker tasks behave identically to unsandboxed ones.
8. `npm test`, `cargo test`, `make e2e` green; `docs/e2e-coverage.md` updated.
9. This plan is deleted and anything still true is folded into
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

**Works.** An earlier revision of this doc said it loaded hooks and never ran
them. That was wrong, and the way it was wrong is the useful part.

All five events fire: `PreInvocation`, `PreToolUse`, `PostToolUse`,
`PostInvocation`, `Stop`. The `Stop` payload is the done edge and is a good one:

```json
{"conversationId": "...", "executionNum": 0, "fullyIdle": true,
 "terminationReason": "NO_TOOL_CALL", "error": "", "modelName": "...",
 "transcriptPath": "...", "workspacePaths": []}
```

Two things have to be right at once, and getting either wrong looks exactly like
"hooks are broken":

1. **The config path is `~/.gemini/config/hooks.json`.** The binary also contains
   `~/.gemini/antigravity-cli/hooks.json`, and a config placed there LOADS
   (`loaded 1 named hooks from 1 hooks.json file(s)`) but never executes. That
   path is a bug they already fixed: *"Fixed a bug where the `/hooks` command
   wrote configurations to `~/.gemini/antigravity-cli/hooks.json` instead of the
   shared `~/.gemini/config/hooks.json`, ensuring hooks remain synchronized
   between the TUI and the backend."* Loaded-but-never-fired is precisely what
   desynchronised means.
2. **The schema is heterogeneous.** Tool events take a matcher group; the
   matcher-less events take handlers DIRECTLY:

```json
{
  "termic-lab": {
    "enabled": true,
    "PreToolUse":     [{ "matcher": "*", "hooks": [ {"type":"command","command":"..."} ] }],
    "PostToolUse":    [{ "matcher": "*", "hooks": [ {"type":"command","command":"..."} ] }],
    "PreInvocation":  [ {"type":"command","command":"..."} ],
    "PostInvocation": [ {"type":"command","command":"..."} ],
    "Stop":           [ {"type":"command","command":"..."} ]
  }
}
```

Wrap the last three in `{matcher, hooks}` and they register with an EMPTY
command: visible in the listing, silently inert.

**Use `agy -p "/hooks"` as the ground truth.** It answers non-interactively and
prints the command it resolved per event, so an empty command column tells you
the shape is wrong before you spend a turn wondering why nothing fired. There is
also `--output-format json` for the structured version.

`decision` is documented as required on `PreToolUse` and `Stop`, but a hook that
returns NOTHING is handled safely and the turn completes normally (measured;
their changelog records the fix: *"safely handling empty decision strings
returned by pre-tool hooks"*). So a passive observer is viable here after all.
Still never emit a decision deliberately.

What agy does NOT have is any attention or notification event, so hooks give it
working and done but not needs-you. Since it emits **no OSC at all**, that is
still a large upgrade: today termic falls back to byte-quiet with a
`fallbackReason` of `attention`, so every agy turn ends in an orange bell.

### Grok 1.0.5

**Read `~/.grok/docs/user-guide/10-hooks.md` first.** It ships with the binary,
so it is version-matched, and it is far better than the website. Everything below
was measured against 1.0.5 after that doc corrected an earlier, wrong reading.

Measured events:

| termic edge | event | payload |
|---|---|---|
| working | `UserPromptSubmit` | `prompt`, wrapped in `<user_query>` tags |
| done | `Stop` | `reason="end_turn"` |
| interrupted | `StopCancelled` | `reason="user_interrupt"`, 435ms after ESC |
| attention | `Notification` | `notificationType="permission_prompt"`, `message`, `permissionMode`, `level` |

`StopCancelled` is unique across the five agents: it also covers a declined
permission prompt, `--max-turns`, and a no-progress bail-out, each with its own
`reason`. Claude and Codex fire nothing at all on an interrupt.

Payloads are **camelCase** (`hookEventName`, `sessionId`, `cwd`,
`workspaceRoot`, `transcriptPath`, `permissionMode`), and the event value inside
is snake_case (`"hookEventName": "notification"`) even though the config key is
PascalCase. `permissionMode` values are `default`, `auto`, `plan`,
`bypassPermissions`; Claude's `acceptEdits` and `dontAsk` have no equivalent, so
a check for those never matches.

Do not use `idle_prompt` as an attention signal: the shipped doc states it fires
on ANY turn end, interrupted or errored included, because it reports a state
rather than an outcome. Match `notificationType`, never `message`, which is
display text that changes between releases.

**Its titles are rich but must not be trusted alone:**

```
grok                                       idle
SPIN - Waiting for response... - grok      busy (waiting on the MODEL, not you)
SPIN - Thinking - grok                     busy
SPIN - Writing file... - grok              busy
Exact One Word Pong Reply Request - grok   idle, with a summary
```

`Waiting for response...` means waiting for the model, so reusing codex's
`\b(Waiting|Action Required)\b` pattern would badge needs-you every turn. And
**when grok blocks on plan approval its title freezes on a busy spinner**:
measured at 217 seconds on one frame with no idle transition. Title patterns
without the `Notification` hook would recreate the Codex latch, so the two land
together or neither does.

Today grok is signal-silent to termic (not in `BUILTIN_TITLE_SIGNALS`), so
byte-quiet fires with `fallbackReason` of `attention`: imprecise, never stuck,
and accidentally right while blocked.

### opencode 1.17.11

See "Phase 2".
