# Profiles (multi-window, Chrome-style)

Deferred, not yet built. Captured here so the intent is not lost.

## The idea

A **Profile** is a fully isolated termic instance: its own projects, tasks, and
settings, running in its own window. The mental model is Chrome profiles, not a
view filter, but a separate identity with separate data.

```
Profile A  (e.g. "Work")        own window, own projects + tasks
Profile B  (e.g. "Open Source") own window, own projects + tasks
```

## Why

Projects and tasks today live in a single global store. A solo developer
with one context is fine. A developer with distinct work / personal / client
contexts has no way to keep those namespaces separate without archiving
everything and restoring it manually.

Note: this is distinct from the planned **Space** layer
(`docs/ideas/space-layer.md`), which adds Arc-style horizontal grouping
*within* a single namespace. Profiles add *isolation between* namespaces,
each in its own window. See "Spaces vs Profiles" below for how the two compose.

## Window model: one window per profile

1:1 profile-to-window. Not a compromise, a consequence of how termic holds
state: the Zustand store is the live source of truth and it is per-webview.
A second window is a second WKWebView with a second JS runtime; there is no
shared store across two windows without promoting Rust to be authoritative
for UI state (tab selection, mounted tasks, panel layout, live titles) and
turning every store write into an IPC round-trip. That is a rewrite of the
store layer, not a feature on top of it.

It also breaks at the terminal itself: a task's xterm.js buffer, WebGL
context, and scrollback live in one webview's DOM. The same task open in two
windows of one profile means either two WebGL terminals drawing the same PTY
(straight into the idle-CPU/GPU budget, see performance.md bear trap 2) or
tearing down and replaying scrollback whenever the task "moves" between
windows. PTY output routing in Rust would need "which window(s) subscribe to
this pty id" instead of "the window."

Profile-per-window has none of this: two profiles are two disjoint data
sets, each window's store owns its profile completely, and nothing but
truly global state (update availability) crosses the boundary. That is
exactly the isolation the feature sells, and it happens to be the only shape
the current architecture supports without a sync layer.

Multi-window-per-profile (several windows sharing one profile's live data,
the way Chrome itself works) is a plausible v2, but only after a
Rust-authoritative sync layer exists, and Spaces will likely absorb most of
the demand for it anyway (see below). Don't build it in v1.

## Process model

One process, one webview window per profile. Not separate OS processes.

The PTY registry, per-task CONNECT proxy threads, and sandbox provisioning
are already keyed per-task in the one Tauri binary and are indifferent to
which window's profile a task belongs to; the sandbox cages the agent
process, not the app. One process also keeps one Dock icon, one updater
instance, and one CLI control socket, versus N of each. The only real
argument for separate processes is crash containment, and it's weak here: a
Rust panic takes down the shared PTY host either way, and a webview crash is
already per-window in Tauri. One process also keeps "move this task to
Profile B" possible later, as a metadata move (the worktree itself doesn't
need to move, see migration below).

## Scope: what a profile owns

Profile-scoped:
- **Projects** (`projects.json`) and project groups. The point of the feature.
- **Tasks** (`tasks/<uuid>.json`), owned via projects.
- **`repos_dir` / worktrees base.** "Client work under `~/clients`, OSS under
  `~/oss`" is a core use case.
- **Global YOLO toggle.** Risk posture is per-context.
- **Per-task sandbox extras and the default sandbox mode for new tasks.**
  Workflow policy; the non-negotiables (secrets deny-list, `builtin_rw_paths`,
  per-CLI network filters) stay baked into Rust and global, a profile can
  only choose modes, never weaken the floor.
- **Window state.** Note: `tauri-plugin-window-state` keys by window label,
  so profile windows need stable distinct labels (`profile-<id>`), or every
  profile fights over one saved frame.
- **Selected theme.** The strongest UX argument for scoping appearance: a
  visibly different accent per window is how you know which profile you're
  typing into. This is the part of Chrome profiles people actually rely on.

Global:
- **Keyboard shortcuts.** Muscle memory doesn't change per identity; no use
  case was named for scoping it.
- **Custom theme *files*** (`~/.config/termic/themes/*.json`). User-authored
  assets shared across builds today; profiles pick from the shared set, they
  don't fork it.
- **Update channel and the update banner.** One binary, one update. Render
  the banner in every profile window off shared Rust state.
- **`welcomed` and other one-time onboarding flags.**
- **Rust-baked sandbox invariants** (secrets denies, per-CLI hostname
  filters). Security floor is per-machine, not per-profile, otherwise the
  laxest profile is the one that gets exploited.
- **The CLI control socket.** One socket, one token store (see CLI section
  below for addressing).

Genuinely ambiguous:
- **Agents registry** (`settings.agents[]`: command paths, args,
  `yolo_args`, enabled/disabled, customs). This fuses machine facts (detected
  binary paths, identical across profiles, annoying to re-detect per
  profile) with workflow policy (which CLIs are enabled, which is legitimate
  to differ per profile, e.g. a client profile banning codex outright).
  Lean profile-scoped, seeded from a shared detection pass on profile
  creation, but a global registry with per-profile enable flags is a real
  alternative and this is not settled.
- **Prompt library** (`src/store/prompts.ts`, localStorage-backed today).
  Profile-scoped matches the mental model (work prompts reference internal
  systems; a screen-shared OSS window leaking work prompt titles is a real
  failure), but the first ask after scoping it will be "share this prompt
  across profiles," with no sync answer yet. Lean profile-scoped with a
  later "copy to profile..." action; a shared library with per-profile
  visibility is the more complex end state and shouldn't be v1.
- **Notification prefs / attention notifier settings.** Per-profile "don't
  notify me for OSS tasks during work hours" is plausible; global is
  simpler and notifications already carry task context. Lean global for v1
  purely on cost.

## Spaces vs Profiles

Spaces are per-profile. A Space groups within a namespace; a Profile is the
namespace boundary. A global Space would, by definition, surface a work
project inside the OSS profile's window, which breaks the one contract
profiles make: isolation, including visual isolation for screen sharing.
There's no cross-profile Space use case that isn't better served by moving
the project to the right profile.

Build-order consequence: if Spaces ship first, the profiles migration is
trivial (the default profile inherits all Spaces as-is). If Profiles ship
first, Spaces land as a per-profile field from day one. Also worth being
honest that the two features compete for the same demand: a lot of "I want
profiles" is really "I want my sidebar grouped," which Spaces solve at a
fraction of the cost below. That argues for shipping Spaces first, and
Profiles only if hard-isolation demand survives Spaces shipping.

## Costs and gaps to resolve before this becomes a plan

- **localStorage is not per-profile and never will be for free.** All
  profile windows share one webview origin, so everything currently in
  localStorage is silently global today: the prompt library, project-group
  collapse state and folder colors, `taskExpandMode` / `collapsedTasks`, the
  `newTaskLast*` keys, and anything else not keyed by task UUID (UUID-keyed
  entries are fine, UUIDs are disjoint across profiles). This needs either a
  `profile:<id>:` key namespace or a move to the per-profile data dir on
  disk. This is the single biggest hidden cost of the feature.
- **Migration path.** Default profile = the existing data dir as-is, moved
  nothing. `profiles/<id>/{projects.json,tasks/,settings.json}` subdirs are
  created only for NEW profiles. Critically, **worktree directories never
  move**, same reason the workspace→task migration refused to: CWD-resume
  agents (`claude --continue`) key sessions to the working directory, and
  relocating a worktree silently orphans its history. Per-profile worktree
  bases apply to new tasks only.
- **The termic CLI needs profile addressing.** "The running app" stops being
  one namespace. Minimum: `--profile <name>` on every command, plus a
  default rule when it's omitted (exactly one profile window open: use it;
  otherwise error and list profiles, never guess). One socket, Rust routes
  by profile.
- **Cmd+N is already taken.** It's bound to "New task..." (the quick task
  picker, `src/lib/shortcuts.ts`), not free for Chrome's "new
  profile/window" convention as the original draft of this doc assumed. The
  profile switcher needs another home: a Dock icon menu (works even with no
  window focused) plus a command-palette entry is the cheap answer; a
  title-bar pill costs chrome space the app deliberately keeps minimal.
- **Global UI on per-window webviews.** The update banner, the settings
  dialog, and attention notifications are app-level today. Each needs a
  rule: banner renders in every window off shared Rust state; settings
  dialog splits into a per-profile section and a global section (this is
  where the scope table above becomes literal UI); a clicked notification
  must focus the OWNING profile's window, so the notifier needs to carry a
  profile id.
- **The perf budget multiplies.** N profile windows = N webviews, N WebGL
  terminal renderers, N sets of mounted tasks. `make perf`'s idle-CPU and
  GPU numbers are measured on one window today. Decide the multi-window
  idle budget, and whether background profile windows should aggressively
  unmount (they hold their own live PTYs, so `display: none` discipline per
  performance.md bear trap 2 applies per window, not just per pane).
- **`schema_version` forks.** Each profile's `settings.json` migrates
  independently; migration code must tolerate profiles sitting at different
  versions after a downgrade/upgrade cycle.

## Open questions

- Profile switcher UX: Dock icon menu, command palette, something else?
  (Cmd+N is out, see above.)
- Exact shape of "move this task to Profile B" if/when it's built: same
  process makes it possible, but it still needs a UI and a rule for what
  happens to the task's live PTY mid-move.
