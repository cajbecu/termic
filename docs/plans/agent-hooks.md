# Agent lifecycle hooks (investigation)

**Status: research, not a build order.** Nothing here is approved for
implementation. The question this doc exists to answer is whether hooks
are reliable enough to be worth adding at all, and if so, for which of
the four things they promise.

Termic infers "the agent finished" from the terminal stream, and that
works. Every supported agent CLI now also exposes a lifecycle hook
system that states it outright, with a payload richer than a boolean.
That is either a real upgrade or a config-mutating dependency that buys
us little. We do not know yet.

So: **[run the measurement first](#step-1-measure-hooks-against-osc-before-anything-else)**.
Everything after it (the direction, the architecture, the phasing) is
written down so the research has something concrete to falsify, not
because it is decided. Treat the design sections as the strawman the
data gets to knock over.

The parts that are settled, because they are constraints rather than
choices: OSC detection stays authoritative and is never replaced; hooks
never block or modify agent behaviour; sandboxed tasks are out of scope
for any first version (see [Sandbox](#sandbox-the-one-real-constraint)).

## Why

Today's detection reads what the agent tells the terminal:

- Claude Code emits `OSC 9;4` (ConEmu/iTerm progress). State 3 busy, 0 idle.
- Gemini sets the OSC 0 window title: `◇ Ready`, `✦ Working…`, `✋ Action Required`.
- Codex does the same with `Working` / `Thinking` / `Ready` / `Waiting` / `Action Required`.

That was the right call and it stays. It needs no config, works for
every agent a user adds themselves, and survives inside the sandbox.

What it cannot do:

1. Tell "blocked on a permission prompt" from "blocked on a question".
   Both surface as one yellow bell.
2. Hand us the assistant's closing message, which is the raw material
   for auto-titled tasks and a searchable session index.
3. Warn before context compaction, which is what a 40-task sidebar
   needs to show which agent is about to lose its head.
4. Report subagent completion at all.

Hooks give us all four, from a payload the CLI already assembles.

## Research: hook support across the supported agents

Verified August 2026. All seven first-class agents have a hook or event
system. Most speak a Claude-compatible nested JSON shape, so one
normalising layer covers the field.

| Agent | Config location | Turn-done event | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `Stop` | Also `Notification`, `PreCompact`/`PostCompact`, `SubagentStop`, `SessionStart`/`SessionEnd`. Supports `type: "http"` and `async: true`. |
| Codex | `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml` | full lifecycle hooks, plus legacy `notify` (`agent-turn-complete`) | `notify` is a root key in TOML and must precede all tables. |
| Gemini CLI | `~/.gemini/settings.json` | `AfterAgent`, `SessionEnd` | `Notification` covers idle, awaiting input, tool confirmation. Lifecycle matchers are exact strings; tool matchers are regex. Hooks run synchronously in the agent loop. |
| Antigravity (`agy`) | `hooks.json` under `~/.gemini/config/` (or `.agents/` in a workspace) | `Stop`, `PostInvocation` | `PreInvocation`/`PostInvocation`/`Stop` take handlers directly, matcher ignored. |
| GitHub Copilot CLI | `~/.copilot/config.json` | `agentStop` | Also `sessionStart`/`sessionEnd`, `preCompact`, `errorOccurred`, `userPromptSubmitted`. camelCase event names. |
| Cursor CLI | `~/.cursor/hooks.json` | `stop` | `{"version": 1, "hooks": {...}}`. `beforeShellExecution` is the permission gate. Fail-open by default. |
| Grok CLI | `~/.grok/user-settings.json` | Claude-compatible nested JSON | **User scope only**, no repo-local config. |
| opencode | TS plugin module, or SDK `client.event.subscribe()` | `session.idle` | 25+ events including `session.compacted`, `session.error`. An event stream, not a spawned process. The community already uses `session.idle` for context-window percentage. |

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Codex advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced),
[Gemini CLI hooks](https://geminicli.com/docs/hooks/),
[Antigravity hooks](https://antigravity.google/docs/hooks),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[Cursor hooks](https://cursor.com/docs/hooks),
[opencode plugins](https://open-code.ai/en/docs/plugins),
[Grok CLI](https://github.com/superagent-ai/grok-cli).

**Confidence note for the implementer.** The Claude and Codex rows were
read from primary docs. Gemini, Antigravity, Copilot, Cursor and Grok
were read from doc summaries and secondary sources; re-verify the exact
JSON shape and event spelling against the vendor doc before writing each
adapter. The event *names* are reliable, the surrounding envelope is the
part to check.

### Payload fields we care about

Claude `Stop`:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/x/.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/x/Work/Repos/termic",
  "hook_event_name": "Stop",
  "last_assistant_message": "I've completed the task...",
  "stop_reason": "end_turn"
}
```

Claude `Notification`: `{"message": "...", "notification_type": "permission_prompt"}`.

Codex `notify` (single JSON argv, not stdin): `type`, `thread-id`,
`turn-id`, `cwd`, `input-messages`, `last-assistant-message`.

Every payload we need carries `cwd`. Claude and Codex also carry a
session/thread id. That is enough to correlate (see below).

### What Xirp actually does (measured, not documented)

Spotify's Xirp 0.12.0 was installed and driven on a real machine in
August 2026. Its onboarding offers a "session hooks" step ("Installs
lightweight hooks into coding agents so Xirp can tell when a session is
working, idle, or waiting"), listing Claude and Codex only. Its own
daemon log shows what it does otherwise, and the shape is worth knowing
because it is the alternative to hooks:

- **tmux, not a PTY.** Sessions are `tmux new-session -d -s xirp-<uuid>
  ... remain-on-exit on`. Session persistence across app restarts is
  tmux's, not theirs.
- **A separate daemon** on `127.0.0.1:<port>`, with the Electron app
  connecting to it as a client. `CHIRP_DAEMON_PORT` is injected into
  every session.
- **A Node launcher**, `@chirp/squab/dist/cli.js --launch-claude
  --session-id <uuid>`, rather than the agent binary directly.
- **System prompt injection.** Every session gets `--append-system-prompt`
  carrying a tutorial for their `chirp session new --goal ... --name ...
  --new-branch ... --depends-on ... --project ...` CLI, so an agent can
  spawn sibling sessions and queue dependent ones. A session DAG driven
  by the agent. Not mentioned in any launch material.
- **Titles by reading the CLI's own transcript.** `readClaudeTitleForSession`
  scans `~/.claude/projects/<slug>/*.jsonl`. No hook needed for this.
- **Env pinning**: `CLAUDE_CODE_NO_FLICKER=1`, `CLAUDE_CODE_SCROLL_SPEED=3`,
  `DISABLE_AUTO_UPDATE`, `DISABLE_UPDATE_PROMPT`, `FORCE_COLOR=3`,
  `COLORTERM=truecolor`, `LANG=C.UTF-8`. Geometry fixed at `-x 120 -y 30`.

Observed with hooks NOT installed (the user's `~/.claude/settings.json`
was never touched): the per-session context meter still reported a live
percentage, so token counts come from the transcript JSONL, not from a
hook. Work state, however, had **no fallback at all**. The badge latched
to "working" and stayed there for twenty minutes across a cancelled turn
and a completed one, with the Stop control still armed, while the agent
sat idle at a prompt. Their onboarding says as much: "Without hooks, Xirp
can't tell when Claude is idle or needs input, so minimap badges and
sounds won't work." So the entire work-state feature is a hard dependency
on mutating the user's agent config, and declining it degrades to a
confident wrong answer rather than to nothing.

Two constraints for this design fall out of that:

1. **Hooks are never the only source of work state.** OSC stays
   authoritative. A user who declines the toggle must lose precision,
   never correctness.
2. **Hook-derived state must not latch.** A later OSC transition has to
   be able to override it, because there is no `Stop` event on a
   cancelled turn and any completion-shaped signal will miss interrupts.

Two takeaways for this design. First, the transcript JSONL is a real
alternative source for titles and token counts, so some of the payoff
listed below does not depend on hooks at all and can ship earlier.
Second, their hook install is global too, for two agents, bundled into
onboarding rather than opt-in. Being opt-in with a working uninstall is
the differentiator, not the location.

## Decision: global install, opt-in

Hooks are written to the user's **global** agent config, gated behind a
Settings toggle that ships **off**, with an explicit uninstall.

### Why not per-worktree

Per-task scoping looked better (self-cleaning, no global footprint) and
is wrong here:

1. **It pollutes the user's diff.** `.claude/settings.local.json` is
   gitignored by Claude's own convention, but `.codex/hooks.json`,
   `.gemini/settings.json` and `.cursor/hooks.json` are not reliably
   ignored. They would appear as untracked files in termic's own diff
   pane on every task.
2. **Symlinks defeat the scoping.** Termic already symlinks repo-root
   dirs (`.claude` and friends, Settings → Tasks) into each new worktree
   so agents keep gitignored project config. A write into the worktree's
   `.claude` travels the symlink into the user's real repo.
3. **It does not cover every task.** Repo-root tasks and non-git projects
   have no worktree to scope to, so the global path is needed anyway.
   Two mechanisms, one of which is the dangerous one, is worse than one.

Global gives one write, one uninstall, one place for the user to
inspect, and identical behaviour for worktree tasks, main-branch tasks
and plain folders.

Xirp installs globally too, for two agents, silently as part of
onboarding, with no merge story stated. Our differentiators are that it
is opt-in, it merges rather than clobbers, it uninstalls cleanly, and it
covers the whole agent roster rather than the two with the biggest
market share.

## Architecture

```
agent CLI ── spawns ──> `termic hook` ── NDJSON frame ──> termic.sock ──> app
   (global config)         (termic-cli)                   (cli_server.rs)
```

### 1. The callback binary

A new `termic hook` subcommand in `termic-cli`. It reads the payload on
stdin (Codex passes it as a single argv instead, so accept both), frames
it as one NDJSON message, writes it to the control socket, exits.

Why a binary rather than per-agent shell snippets:

- One stable command string in six config files. Agent-specific event
  names and payload spellings normalise in one place in Rust.
- No PATH assumptions, no `jq` dependency, no quoting hazards inside
  JSON-inside-TOML.
- Claude supports `type: "http"`, but nothing else does, so HTTP would
  mean two transports. The socket already exists and is already
  same-uid checked via `getpeereid`.

If termic is not running the connect fails and the process exits 0
immediately. A hook must never be the reason an agent stalls.

### 2. Normalised event model

Adapters map vendor events onto a small internal set:

| Internal | Claude | Codex | Gemini | agy | Copilot | Cursor | opencode |
|---|---|---|---|---|---|---|---|
| `turn_done` | `Stop` | `notify` / lifecycle | `AfterAgent` | `Stop` | `agentStop` | `stop` | `session.idle` |
| `attention` | `Notification` | n/a | `Notification` | n/a | n/a | n/a | n/a |
| `compact_soon` | `PreCompact` | n/a | n/a | n/a | `preCompact` | n/a | `session.compacted` |
| `session_end` | `SessionEnd` | n/a | `SessionEnd` | n/a | `sessionEnd` | n/a | `session.deleted` |
| `subagent_done` | `SubagentStop` | n/a | n/a | n/a | n/a | n/a | n/a |

Gaps stay gaps. OSC covers `turn_done` for every agent regardless, so a
missing adapter event degrades to today's behaviour, never to nothing.

### 3. Correlation to a task

Order of resolution:

1. `session_id` / `thread-id` against the tab's recorded session id
   (termic already tracks this for resume).
2. `cwd` against task worktree paths, and against multi-repo member
   paths.
3. If neither resolves, drop the event. Never guess.

Repo-root tasks can share a `cwd` across two tabs, which is exactly why
session id is tried first.

### 4. Config writing, merge and removal

The writer must survive a user who already hand-wrote hooks.

- Read the existing JSON/TOML, preserving unknown keys.
- Append termic's entry into the existing array for that event.
- Tag every entry with a marker, e.g. `"_termic": 1` where the schema
  version is the value.
- Install is idempotent: an entry with our marker is replaced, not
  duplicated. A bumped schema version replaces the older entry.
- Removal deletes only marked entries, then removes now-empty arrays and
  objects that we created, leaving the file byte-identical to its
  pre-install state when nothing else changed.
- Write atomically (temp file + rename). Never leave a half-written
  agent config on disk; that breaks the agent, not just termic.
- Back up the original file once per agent on first install, so a
  botched merge is recoverable.

Codex is the awkward one: hooks may live in `hooks.json` **or** as
`[hooks]` tables in `config.toml`, and the legacy `notify` key is a TOML
root key that must appear before any table. Prefer `~/.codex/hooks.json`
and leave `config.toml` alone entirely.

### 5. Safety rules

Non-negotiable, because a bad hook makes termic the thing that froze the
user's agent:

- **Never** emit `decision: "block"`, `permissionDecision`, or any other
  control field. We observe, we do not gate.
- Set `async: true` where the CLI supports it (Claude does). Claude and
  Gemini otherwise run hooks synchronously inside the agent loop.
- Short timeout (1s or less). Fail open on every path.
- Exit 0 on every error, including malformed payloads and a missing
  socket.
- No network, no filesystem writes, no logging to the user's repo.

## Sandbox: the one real constraint

`sandbox.rs` denies caged agents both the data dir and the control
socket, in `EnforceFs` as well as full enforce mode (`sandbox.rs`, the
"Termic control plane" final rules). That is deliberate: granting an
agent the CLI is granting terminal access, and `docs/plans/cli.md`
settles that caged agents get no control plane at all.

So a hook spawned by a sandboxed agent **cannot** call back. Hooks are
therefore useless for exactly the tasks users care most about, unless a
second path exists.

**v1: do not build one.** Sandboxed tasks keep OSC detection, unchanged.
Hooks improve unsandboxed tasks. No security surface moves.

**v2, if it proves out:** ride the per-task bearer token on a loopback
port described in `docs/plans/mcp.md` rather than inventing a second
socket. That design already solves "which task is calling, and what may
it do", and a status-report endpoint is a far narrower grant than the
tool surface it was written for. Do not reopen the control socket to
caged agents under any circumstance.

## What we get beyond a better bell

Wire these in the same pass, since the payload already carries them:

- **Auto-titled tasks.** `last_assistant_message` / `last-assistant-message`
  gives a real title instead of "Untitled session". Termic has no
  auto-titling today.
- **Two distinct attention states.** `notification_type` splits
  "blocked on permission" from "blocked on a question". Today both are
  one yellow bell.
- **Context-window pressure.** `PreCompact` / `preCompact` /
  `session.compacted` drives a per-task context meter in the sidebar.
  Termic shows nothing today.
- **Session index groundwork.** `transcript_path` points at the CLI's
  own JSONL. Recording it per task is the cheap half of a local,
  on-device "what did we already try" search, with no upload anywhere.

## Settings UX

Settings → Notifications:

> **Exact work-done detection**
> Installs a small hook into your coding agent config so termic knows the
> moment an agent finishes or needs you, instead of inferring it from the
> terminal. Off by default.
> Files changed: `~/.claude/settings.json`, `~/.codex/hooks.json`, ...
> [Install hooks] [Remove hooks]

- Off by default. Flip the default only once field data shows it stable.
- List the exact files before writing, not after.
- Show per-agent state (installed, not installed, agent not detected),
  the way Settings → Coding Agents already lists detected CLIs.
- "Remove hooks" is always available, even if the toggle is off, so a
  user who uninstalls termic mid-experiment can still clean up.
- Copy rule: no em dashes anywhere in this UI.

## Failure modes to handle explicitly

| Failure | Behaviour |
|---|---|
| Agent config is malformed JSON | Do not write. Surface a settings-level error naming the file. |
| User edits our entry by hand | Removal still matches on the marker key; if the marker is gone, leave it alone. |
| Agent CLI upgrades and changes its schema | Version the marker. On mismatch, remove and reinstall. |
| Two termic instances (different data dirs) | Marker carries the data dir hash so each removes only its own. |
| Hook fires for an unknown cwd/session | Drop silently. |
| Socket missing (app not running) | Exit 0 in under a millisecond. |
| Hook fires for a sandboxed task | Cannot happen in v1 (socket denied). Ensure it fails silently rather than retrying. |

## Testing

Both required before this lands, per `CLAUDE.md`.

**Rust unit tests** on the config writer, one set per agent adapter:

- install into an empty config
- install into a config that already has user hooks (user hooks survive)
- install twice (idempotent, no duplicate entry)
- upgrade from an older marker version (replaced, not appended)
- remove (file is byte-identical to the pre-install original)
- remove when the user edited our entry (left alone)
- malformed input (no write, error surfaced)

**Unit tests** on the normaliser: each vendor payload maps to the right
internal event and correlates to the right task.

**e2e spec** (`e2e/specs/`, per the `e2e` skill): toggle on, assert the
config diff on a fixture HOME, assert a hook-driven state change reaches
the DOM, toggle off, assert clean restore. Add it to
`docs/plans/e2e-coverage.md`.

## Step 1: measure hooks against OSC, before anything else

This is the actual task. It decides which of the payoffs above are
reachable, and whether any of the design below is worth writing. It is
cheap, and no code ships until it has run.

Possible outcomes, all acceptable:

- Hooks fire reliably and cover the gaps. Build phase 1.
- Hooks fire but only add the permission-versus-question split. Build
  that one thing, drop the rest.
- Titles and token counts come from the transcript JSONL anyway (Xirp
  gets them with no hooks at all), so the config write buys almost
  nothing. Skip hooks, read the JSONL, close this doc.
- Hooks are flaky across agents. Say so publicly, keep OSC, done.

Harness: a scratch `HOME` whose agent config installs a hook that appends
`{event, timestamp, payload}` to a log; the agent spawned in a PTY with
the raw stream tee'd to a file so OSC transitions can be extracted with
timestamps; a driver that sends the keystrokes for each scenario. One
table out: fired / missed / latency, per signal, per scenario.

| Scenario | Question |
|---|---|
| Turn completes normally | `Stop` fires, OSC → idle. Latency of each. |
| Escape mid-tool-call | Anything at all? (expect no `Stop`, OSC fires) |
| Double escape / rewind | Same |
| Permission prompt appears | `Notification` + `notification_type` vs OSC busy→idle |
| Plan mode awaiting approval | Which signal marks "needs you" |
| Agent asks a question, no tool call | Does the turn end |
| Subagent finishes | `SubagentStop` vs no OSC transition at all |
| Compaction | `PreCompact` / `PostCompact` timing |
| API error mid-turn | `StopFailure` vs OSC |
| `/clear`, `/resume`, session switch | False positives |
| Agent exits (ctrl-D) | `SessionEnd` vs PTY EOF |
| Two agents in one worktree | Does `cwd` disambiguate, or is session id required |

Run it per agent, not just Claude. The event vocabularies differ enough
that a result for one says little about the others.

This scenario list doubles as the e2e spec for the feature once it
lands, and as publishable evidence for the "protocol beats inference"
claim.

## Phasing (only if the measurement justifies it)

0. The measurement above. Nothing below starts until it has run and the
   result is written back into this doc.
1. `termic hook` subcommand, socket frame, normaliser, correlation.
   Claude adapter only. Toggle in Settings, off by default.
2. Codex, Gemini, Antigravity, Copilot, Cursor, Grok adapters.
   opencode via its plugin/event API rather than a spawned process.
3. Consume the richer payload: auto-titles, split attention states,
   context meter.
4. Sandboxed-task path, only if 1 to 3 prove stable, and only over the
   `mcp.md` per-task token.

## Open questions

- opencode wants a TS plugin, not a spawned binary. Ship a tiny plugin
  from the app, or subscribe to its event stream from the Rust side and
  skip config writing entirely? The latter is cleaner and has no
  uninstall story to get wrong.
- Does the context meter need `PreCompact` at all, or can token counts
  be read from the transcript JSONL that `transcript_path` already
  hands us? Xirp reads the JSONL directly for titles, which suggests the
  transcript route works today with no config writing at all. If it
  covers titles and token counts, phase 3 may not need hooks, and the
  hook work narrows to the two things only hooks provide: the
  permission-versus-question split, and subagent completion.
- Codex `notify` versus its newer lifecycle hooks: is `notify` worth
  supporting as a fallback for older Codex versions, or do we require a
  minimum version and keep one code path?
