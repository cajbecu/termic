# Agent-driven orchestration (research)

**Status: research, not a build order.** The question is not whether
agents can drive other tasks. They can, and they are already told how.
The question is whether the telling actually lands, and how much
orchestration shape termic should have an opinion about.

The plumbing exists and is complete. `termic new` creates a task and
starts its agent with a prompt, with `--wait`. `termic wait` blocks on a
work state. `termic send` pushes a message into a running task.
`termic result`, `termic logs`, `termic status`, `termic archive` close
the loop, all with `--output-format json`. Composed, that already
expresses "start B when A finishes", which is the primitive everyone is
racing to ship.

The telling exists too. Every spawned agent gets `TERMIC_CLI`,
`TERMIC_CLI_TOKEN`, `TERMIC_TASK_ID` and `TERMIC_CLI_HELP` in its
environment (`src-tauri/src/lib.rs`), and the help string is a real
tutorial: spawn with `--sandbox enforce --wait`, drop findings in
`RESULT.md`, prompt an existing task with `send --wait`, branch on exit
codes (0 done, 3 needs input, 7 timeout, 9 prompt not delivered), rename
your own task once you know what it is really about.

So the gap is narrower and more specific than "agents cannot
orchestrate". Two things:

1. **Env vars are passive.** `TERMIC_CLI_HELP` is only read if the agent
   happens to look at its environment. Nothing puts it in context. Xirp
   puts the equivalent text in the system prompt, where it is in context
   on turn one whether the agent goes looking or not.
2. **termic has no opinion about shape.** Nothing suggests fanning out,
   queueing, or a supervisor pattern. The surface is there, the intent
   is entirely the user's. That is a defensible position, and it is also
   possibly just an unmade decision.

## Prior art: how Xirp does it

Spotify's Xirp solves the same problem, and close to the way termic
already does: a control CLI, handed to the agent, plus worktree-per-task
underneath. The difference is the delivery, which is why it is worth
reading here rather than as trivia. Inspiration, not a spec.

Measured from a real install of Xirp 0.12.0 in August 2026. The full
teardown is at the [end of this doc](#appendix-xirp-0120-teardown); this
is the orchestration part.

Every session is launched with `--append-system-prompt` carrying a
tutorial for their own CLI. Paraphrased from the injected text:

- `chirp session new --goal "<task>" --name "<3-5 words>"` creates a
  session in the background, no view switch.
- `--new-branch <name>` names the worktree branch.
- `--depends-on [id]` queues the new session as a child that starts
  after the current one completes. With no id it uses the caller's own
  session id, which is available as `CHIRP_SESSION_ID` in the env.
- `--project <ref>` targets a different project by name, path or UUID.
- `--json` returns `{id, name, branch, worktreePath}`.

The injected prompt also carries trigger examples: "refactor the auth
module, and in parallel update the tests" spawns two sessions, "after
you're done with this, deploy to staging" spawns one with
`--depends-on`.

So their orchestration surface is not a UI. It is natural language, and
the API is the system prompt. Fan-out happens because the user asked for
two things in one sentence.

Worth noting: their own daemon log shows `chirp --help` failing with
`command not found` in the external build, so whether the injected
tutorial resolves end to end outside Spotify is unverified.

## Why this is interesting

The design bet is that nobody adopts a DAG editor. Given a canvas with
boxes and arrows, engineers will keep typing prompts instead. Putting
the orchestration in the prompt means the feature ships with no UI at
all, and the discovery problem is solved by the model rather than by
documentation.

The cost is that the graph stays implicit. You cannot see the shape
before it exists, you cannot replay it, and the agent decides how wide
to fan out. The trust question moves from "is this code correct" to
"did it fan out the way I meant".

## Questions this research has to answer

1. **Does injection actually work?** Put termic's CLI surface into
   `--append-system-prompt` (or the equivalent for each agent) and see
   whether agents reach for it unprompted, at the right moments, without
   being nagged. Measure false starts too: an agent that spawns three
   tasks when the user wanted one is worse than an agent that spawns
   none.
2. **What is the minimum prompt?** Every token of injected tutorial is
   paid on every turn of every session. Xirp's is roughly 200 words.
   Find the shortest text that produces correct behaviour, or decide
   this belongs in MCP tool definitions instead, where the schema is the
   documentation (see [../plans/mcp.md](../plans/mcp.md)).
3. **Prompt injection or MCP?** These are alternatives, not a sequence.
   The prompt route works today for every agent that accepts a system
   prompt append, costs context on every turn, and gives no argument
   validation. The MCP route is typed, discoverable and per-task
   scoped, but it only reaches MCP-capable clients and is still in
   design.
4. **Does `--depends-on` need to exist?** `termic wait <task> && termic
   send ...` already composes it. A dedicated flag is one call instead of
   two, and it survives the caller's own session ending. Decide whether
   that is worth a new surface.
5. **How much shape do we bake in?** Fan out, queue behind, supervisor
   and workers. Today termic bakes in none: the user asks, the tool
   obeys. That is a defensible position and it is also possibly just
   indecision. Xirp picked "the model decides, in English". A third
   option is to make the intended shape visible before it runs, without
   drawing a graph.
6. **Opt-in or default?** An agent that can spawn agents is a cost
   multiplier and a blast-radius multiplier. If injection ships, it
   almost certainly ships behind a toggle, and possibly with a cap on
   depth or on total spawned tasks.

## The sandbox constraint

Caged agents get no CLI at all. `sandbox.rs` denies the data dir and the
control socket, and [../plans/cli.md](../plans/cli.md) settles that
deliberately: granting an agent the CLI is granting terminal access.

So injecting a CLI tutorial into a sandboxed session teaches it to reach
for something it cannot have, which is worse than silence. Either
injection is skipped for caged tasks, or orchestration for caged agents
rides the per-task bearer token described in
[../plans/mcp.md](../plans/mcp.md), which was designed for exactly this.

## What termic already has

For reference, so the research does not rebuild it:

| Need | Command |
|---|---|
| Create a task, start the agent, inject a prompt | `termic new` |
| Adopt an existing worktree instead of creating one | `termic new --from <path>` |
| Resume a specific agent session | `termic new --resume <session-id>` |
| Block until a task reaches a work state | `termic wait` |
| Push a message into a running task | `termic send` |
| Read a task's outcome / logs | `termic result`, `termic logs` |
| Inspect state, diff, path | `termic status`, `termic diff`, `termic path` |
| Clean up | `termic archive` |

All of it is JSON-capable via `--output-format json`, which matters if
an agent is the caller.

## Appendix: Xirp 0.12.0 teardown

Kept here because the orchestration choice above only makes sense
alongside the rest of the architecture. Spotify opened Xirp to public
beta on 2026-08-10.

**Provenance.** Public site and docs, their published release manifest,
and installing Xirp 0.12.0 on a Mac and using it. Runtime details come
from the log the app writes to
`~/Library/Application Support/Xirp/xirp-external/xirp.log` and from its
own data directory. The application bundle was not decompiled. Reviewed
2026-08-11.

### What it is

| | |
|---|---|
| Version measured | 0.12.0, released 2026-08-10 |
| Platforms | macOS only (arm64 + x64). Windows and Linux are a waitlist |
| License | Closed. No public repo, no license file |
| Price | App free in beta. Portal is a per-developer annual subscription, quoted by sales |
| Account | Spotify account required at first launch, via Auth0 |
| Agents | Claude Code, Codex, Gemini. No documented BYO path |
| Claimed scale | 1,300+ Spotify engineers, 36,000+ sessions, 100+ internal contributors |

### Distribution

`https://xirp.spotify.com/install.sh` pulls from
`https://reckless-finch.spotifycdn.com/external/`, reading
`latest-mac.yml`. That file is **electron-builder's** auto-update
manifest, which is the first confirmation of the runtime.

Published artifact sizes for 0.12.0:

| Artifact | Size |
|---|---|
| `Xirp-0.12.0-arm64-external.dmg` | 183 MB |
| `Xirp-0.12.0-x64-external.dmg` | 193 MB |
| `Xirp-0.12.0-arm64-external.zip` | 177 MB |

For comparison, termic 0.25.3 ships a 20 MB universal `.dmg`.

### Runtime architecture

**Electron.** `~/Library/Application Support/Xirp/` contains the
standard Chromium profile furniture: `blob_storage`, `Code Cache`,
`GPUCache`, `DawnWebGPUCache`, `Local Storage`, `Trust Tokens`,
`SingletonLock`.

**A separate daemon.** The Electron process connects as a client to a
second process listening on a loopback TCP port. The port is handed to
every session as `CHIRP_DAEMON_PORT`.

**tmux.** Sessions are not PTYs Xirp owns. Each one is:

```
tmux new-session -d -s xirp-<uuid> -e <env...> -c <worktree> -x 120 -y 30 \
  '<launcher> --launch-claude --session-id <uuid> --append-system-prompt "..."' \
  ';' set-option -t xirp-<uuid> remain-on-exit on
```

That is how "sessions survive closing the app" works. tmux does it.
Geometry is fixed at 120x30 at creation.

**A Node launcher.** The agent is not spawned directly. It goes through
`app.asar.unpacked/node_modules/@chirp/squab/dist/cli.js --launch-claude`.

**Environment pinned per session:** `DISABLE_UPDATE_PROMPT=true`,
`DISABLE_AUTO_UPDATE=true`, `FORCE_COLOR=3`, `COLORTERM=truecolor`,
`LANG=C.UTF-8`, `BROWSER=/usr/bin/open`, `CLAUDE_CODE_NO_FLICKER=1`,
`CLAUDE_CODE_SCROLL_SPEED=3`, plus `CHIRP_SESSION_ID`,
`CHIRP_PROJECT_ID`, `CHIRP_NOTIFICATION_ID`, `CHIRP_DAEMON_PORT`,
`CHIRP_EDITION=external`.

### The internal name is Chirp

The daemon logs under `name: "chirp"`, every session env var is
`CHIRP_*`, the launcher is an npm package under the `@chirp` scope, and
the build is tagged `edition: "external"`. Xirp is the external rebrand
of an internal tool called Chirp.

### Orchestration by system prompt

The most interesting thing in the product, and it is in none of the
launch material.

Every session is launched with `--append-system-prompt` carrying a
tutorial for their own CLI. From the log, the injected text teaches:

```
chirp session new --goal "task" [--name "short name"] [--new-branch <name>]
                  [--depends-on] [--project <ref>] [--json]
```

with these semantics, quoted from the injected prompt:

- `--goal <text>` task for the new session (required)
- `--name <text>` short display name, 3 to 5 words, "ALWAYS provide this"
- `--new-branch <name>` names the worktree branch, default an
  auto-generated `session/cli-*`
- `--depends-on [id]` "Queue as child of this session (starts after this
  session completes). Omit id to use the current session."
- `--project <ref>` target another project by name, path or UUID
- `--json` returns `{id, name, branch, worktreePath}`

It also ships trigger examples, so the model knows when to reach for it:

- "Refactor the auth module, and in parallel update the tests" spawns two
  sessions
- "After you're done with this, deploy to staging" spawns one with
  `--depends-on`
- "Fix the flaky test in the backend repo" spawns with `--project backend`

Sessions are created in the background with no view switch. The
fan-out is user-triggered in natural language, not autonomous, and not a
UI.

**Caveat.** Their own daemon log shows `chirp --help` failing with
`/bin/sh: chirp: command not found`. Whether the injected tutorial
resolves end to end in the external build is unverified.

### Work state, and what happens without hooks

Onboarding step 3 offers "session hooks": "Installs lightweight hooks
into coding agents so Xirp can tell when a session is working, idle, or
waiting for your input, essential for the minimap status badges and
notifications. Installed agents: Claude, Codex." Gemini is absent from
that list despite being a supported agent.

It also states the failure mode plainly: "Without hooks, Xirp can't tell
when Claude is idle or needs input, so minimap badges and sounds won't
work."

Measured with hooks declined (`~/.claude/settings.json` was never
touched, mtime predates the install):

- The session badge latched to **working** and stayed there for 20+
  minutes, across both a cancelled turn and a normally completed one,
  with the Stop control still armed, while the agent sat idle at a
  prompt.
- The per-session **context meter kept working**, reporting a live
  percentage. So token counts do not come from hooks.

Two conclusions. Their work-state feature is a hard dependency on
mutating the user's agent config, and declining it degrades to a
confident wrong answer rather than to nothing. And the context
percentage is read from the agent's own transcript, which means that
particular feature needs no hooks at all.

### Titles from the transcript

The log shows `readClaudeTitleForSession(<uuid>): cwd=... cliId=null`,
scanning `~/.claude/projects/<slug>/`. Session auto-naming is done by
reading Claude's own JSONL transcript, not by a hook.

### A fourth agent: `snipe`

`xirp-external/settings.json` carries `coding_agent_defaults` for
`claude`, `codex`, `gemini` and **`snipe`**. The first three hold the
expected per-agent flags (`dangerously_skip_permissions`,
`approval_policy`, `sandbox_mode`, `yolo`). `snipe` holds:

```
provider, thinking, permission_mode, sandbox, yolo,
auto_route, classification_method
```

`auto_route` plus `classification_method` reads as a model router:
classify the task, send it to a provider. That is almost certainly the
machinery behind the "route every job to the best available price
performance" line in the launch material. Not exposed in the UI at the
time of writing.

### Data directory

`~/Library/Application Support/Xirp/xirp-external/`:

| Path | What |
|---|---|
| `settings.json` | agent defaults, onboarding flag, git defaults |
| `auth0-auth.json` | Auth0 tokens for the Spotify account |
| `db/` | app state |
| `backups/` | dated snapshots, including a pre-migration one |
| `installation.json`, `revocation-cache.json` | install identity, revocation |
| `xirp.log` | very chatty daemon log, source of most of the above |

### From the public docs

- Session states: Working, Idle, Waiting, Finished, Failed.
- Grid view of multiple terminals (`Cmd+G`), session minimap with
  configurable position, `Cmd+K` universal search, `Cmd+Shift+K` recent.
- Project tabs: Overview, Git, Files, **Skills**, **Rules**.
- Projects can be git repos, non-git folders, or a parent folder holding
  several repos, where "git controls are limited".
- Session creation box: "What should we build? Type a goal or paste a
  ticket URL".
- Transcripts can be uploaded to a Portal Workspace to share. Their FAQ:
  Xirp "does not scrub or redact credentials, personal data, or
  sensitive content before upload".
- Settings docs state Xirp "does not translate permission or sandbox
  settings between coding agents", and it adds no isolation of its own.
- Portal integration supplies catalog, ownership and dependency context
  at session start, and transcripts flow back into Portal.

### What they have that termic does not

Worth keeping honest:

1. **Organizational context.** Portal's catalog, ownership and
   dependency graph loaded at session start. termic has no equivalent
   and no plan for one.
2. **Context-window meter per session.** Cheap to add, genuinely useful
   past a dozen sessions, and readable from the transcript JSONL.
3. **Auto-named sessions**, from the same transcript.
4. **A grid of live terminals across sessions.** termic splits inside a
   task only. Note this is also the workload where Electron should hurt
   most, so it is a benchmark worth running before copying.
5. **Orchestration in the system prompt.** See
   [agent-orchestration.md](agent-orchestration.md). termic ships the
   same capability through `TERMIC_CLI_HELP` in the environment, which
   is passive: nothing puts it in context.

### What termic has that they do not

1. Open source, AGPL, no account, no backend.
2. A real sandbox: per-task Seatbelt cage plus a network allowlist,
   pinned at creation.
3. Native, 20 MB against 183 MB of Electron.
4. Seven agents plus any PTY command as an eighth.
5. Real multi-repo composition, with a port per member.
6. macOS and Linux builds.
7. Work-state detection that needs no config and degrades to nothing
   rather than to a wrong answer.

### Sources

- <https://xirp.spotify.com/> and `/join-beta`
- <https://backstage.spotify.com/docs/xirp> (docs, FAQ, sessions,
  projects, settings)
- <https://portal.spotify.com/blog/introducing-xirp>
- <https://reckless-finch.spotifycdn.com/external/latest-mac.yml>
- A local install of Xirp 0.12.0 and its own log
