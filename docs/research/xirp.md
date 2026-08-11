# Xirp teardown (research)

Spotify opened **Xirp** to public beta on 2026-08-10. It is the closest
thing to a direct competitor termic has: run the real agent CLIs in
parallel, one git worktree per session, one window.

This is the record of what it actually is, measured rather than
summarised from the launch posts. Referenced by
[agent-hooks.md](agent-hooks.md) and
[agent-orchestration.md](agent-orchestration.md).

**Provenance.** Public site and docs, their published release manifest,
and installing Xirp 0.12.0 on a Mac and using it. Runtime details come
from the log the app writes to
`~/Library/Application Support/Xirp/xirp-external/xirp.log` and from
its own data directory. The application bundle was not decompiled.
Reviewed 2026-08-11.

## What it is

| | |
|---|---|
| Version measured | 0.12.0, released 2026-08-10 |
| Platforms | macOS only (arm64 + x64). Windows and Linux are a waitlist |
| License | Closed. No public repo, no license file |
| Price | App free in beta. Portal is a per-developer annual subscription, quoted by sales |
| Account | Spotify account required at first launch, via Auth0 |
| Agents | Claude Code, Codex, Gemini. No documented BYO path |
| Claimed scale | 1,300+ Spotify engineers, 36,000+ sessions, 100+ internal contributors |

## Distribution

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

## Runtime architecture

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

## The internal name is Chirp

The daemon logs under `name: "chirp"`, every session env var is
`CHIRP_*`, the launcher is an npm package under the `@chirp` scope, and
the build is tagged `edition: "external"`. Xirp is the external rebrand
of an internal tool called Chirp.

## Orchestration by system prompt

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

## Work state, and what happens without hooks

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

## Titles from the transcript

The log shows `readClaudeTitleForSession(<uuid>): cwd=... cliId=null`,
scanning `~/.claude/projects/<slug>/`. Session auto-naming is done by
reading Claude's own JSONL transcript, not by a hook.

## A fourth agent: `snipe`

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

## Data directory

`~/Library/Application Support/Xirp/xirp-external/`:

| Path | What |
|---|---|
| `settings.json` | agent defaults, onboarding flag, git defaults |
| `auth0-auth.json` | Auth0 tokens for the Spotify account |
| `db/` | app state |
| `backups/` | dated snapshots, including a pre-migration one |
| `installation.json`, `revocation-cache.json` | install identity, revocation |
| `xirp.log` | very chatty daemon log, source of most of the above |

## From the public docs

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

## What they have that termic does not

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

## What termic has that they do not

1. Open source, AGPL, no account, no backend.
2. A real sandbox: per-task Seatbelt cage plus a network allowlist,
   pinned at creation.
3. Native, 20 MB against 183 MB of Electron.
4. Seven agents plus any PTY command as an eighth.
5. Real multi-repo composition, with a port per member.
6. macOS and Linux builds.
7. Work-state detection that needs no config and degrades to nothing
   rather than to a wrong answer.

## Sources

- <https://xirp.spotify.com/> and `/join-beta`
- <https://backstage.spotify.com/docs/xirp> (docs, FAQ, sessions,
  projects, settings)
- <https://portal.spotify.com/blog/introducing-xirp>
- <https://reckless-finch.spotifycdn.com/external/latest-mac.yml>
- A local install of Xirp 0.12.0 and its own log
