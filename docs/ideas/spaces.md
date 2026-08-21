# Spaces

Deferred, not yet built. Captured here so the intent is not lost.

Supersedes the old `profiles.md` and `space-layer.md`, which are folded in.
The naming is not cosmetic: see "What we considered and dropped" at the
bottom for why this is not a Chrome-style Profile, and what that buys.

## The idea

A **Space** is a named, colored group of projects that gets **its own
window**. It sits above Project in the hierarchy:

```
Space                        (a colored group of projects, its own window)
└─ Project                   (a git repo, or a plain folder)
   ├─ Task · main checkout   the repo's original checkout; always present
   └─ Task · worktree feat/x an isolated git worktree (git projects only)
```

Everything below Space already ships. Space is the missing top layer, plus
the window that makes it useful.

The word was reserved deliberately during the Task rename (shipped v0.19.0)
so the new grouping would not read as "the old workspace moved up a level."

| Concept | super.engineering | termic |
|---|---|---|
| Colored group of projects | Workspace | **Space** (this note) |
| A repo or folder | Project | Project |
| Unit of work | (task) worktree | **Task** |
| Isolated branch location | task worktree | Task · worktree `<branch>` |
| Repo-root location | primary worktree | Task · main checkout |

## Why

The ask, from a handful of users, is narrow and worth stating literally:

> I don't want to see my personal projects in my work window, or my work
> projects in my personal window.

That is a **visibility** requirement, not a data-isolation one. It wants a
filter with a window attached. Everything in this doc follows from taking
that literally and refusing to build more.

Projects today live in one global list with a flat `group` label
(`src/lib/types.ts`, `Project.group`) that renders as a collapsible folder
header. That is most of a Space already. What it lacks is a window, an
accent color, and the scoping that keeps the other space's projects out of
the palette.

## The governing rule: inherit by default, override explicitly

**Everything is global unless a Space explicitly overrides it, and creating
a Space overrides nothing.** A brand-new Space has every agent already
detected, the same theme, the same shortcuts, the same prompt library. It
differs only in which projects it shows.

This is the single most important decision in the doc and the one that
separates a feature people want from one they will file bugs against. The
failure mode it prevents: a user asks for a second window, gets a second
installation, and has to configure Claude Code twice. If creating a Space
ever presents a blank settings screen, the model has drifted back into
profiles.

What a Space may override, and nothing else:

- **`env`** (see below). The one that motivated the override list at all.
- **`repos_dir` / worktrees base.** "Work under `~/clients`, personal under
  `~/oss`." Applies to NEW tasks only; existing worktrees never move.
- **Default agent for new tasks.**
- **Default sandbox mode / YOLO for new tasks.** Risk posture is per-context.
  It can only pick among modes, never weaken the Rust-baked floor (secrets
  deny-list, `builtin_rw_paths`, per-CLI network filters), which stays global
  and per-machine.
- **Accent color.** The visual tell. This is the part of the Chrome-profile
  experience people actually rely on: you can see which window you are typing
  into before you share your screen.

Everything else is global: shortcuts, theme files, the agents registry
itself, the prompt library, notification prefs, update channel, onboarding
flags, `schema_version`. One `settings.json`, one migration path, no forks.

## The Space env map

A Space carries `env: Record<string, string>`, persisted on the Space entity
in settings, and `pty_spawn` (`src-tauri/src/lib.rs`) merges it into the PTY
environment at the point where it already applies its env overlay.

This is small and it covers the real use case directly. Work Claude Code and
personal Claude Code are the same binary distinguished by environment:
`CLAUDE_CONFIG_DIR` pointing at a different `~/.claude`, or a different
`ANTHROPIC_API_KEY`. The same field also handles per-context git identity and
any other per-context credential, with no per-Space agent registry at all.

Ship this before considering per-Space custom agents. If those are ever
wanted, they are an overlay on the global registry (enable flags plus extra
customs) while detected binary paths stay global, because paths are machine
facts that are identical everywhere and irritating to re-detect. They are not
a second registry.

Three constraints on the map:

- **It may not set `TERMIC_*`.** `pty_spawn` injects `TERMIC_TASK_ID`,
  `TERMIC_CLI`, `TERMIC_PORT` and friends, and a Space that could overwrite
  them would break the CLI's self-addressing from inside its own terminal.
  Reuse the existing reservation rule (`RESERVED_PORT_NAMES` /
  `valid_port_name`, `lib.rs`), which already exists for exactly this reason
  on extra named ports, and mirror it in the Settings editor.
- **Values land on disk in plaintext.** People will put API keys here, so say
  so in the UI next to the field rather than letting them discover it. It
  also interacts with the sandbox secrets deny-list: a key that is deliberately
  denied to an agent must not arrive through the Space env map instead.
- **It reaches sandboxed agent PTYs**, which is the point, but means the map
  is readable by the agent process. That is fine for a credential the agent is
  meant to use, and wrong for anything else.

## Window model: exactly one window per Space

One Space, one window. Not a compromise; a Space that does not open a window
is just a folder, and a second window on the same Space buys nothing.

The constraint that decides it is in the terminal, not the store. A task's
xterm.js buffer, WebGL context, and scrollback live in one webview's DOM. The
same task mounted in two windows means either two WebGL terminals drawing one
PTY, straight into the idle-GPU budget (performance.md bear trap 2), or
tearing down and replaying scrollback whenever it moves. Neither is worth
paying for a window nobody asked for.

One window per Space also makes task ownership **derivable** rather than
tracked: a task belongs to a project, a project to a Space, a Space to one
window. No mount registry, no "which window has task T" bookkeeping, and PTY
output routing stays one-window-per-task with no fan-out.

Window labels must be stable and distinct (`space-<id>`), because
`tauri-plugin-window-state` keys by label and every Space would otherwise
fight over one saved frame.

## Process model

One process, N webview windows. Not separate OS processes. Settled; the rest
of this doc assumes it.

Everything stateful on the Rust side is already keyed per-task, not
per-window: the PTY registry, the per-task CONNECT proxy threads, sandbox
provisioning, and the port allocator (`task_port_intervals` and its stray
buffer). None of them ask which window a task belongs to, and the sandbox
cages the agent process rather than the app. Two Spaces are two disjoint sets
of task ids in registries that were never window-aware to begin with. Two
processes would mean two PTY hosts and two port allocators racing over one
port space.

One process also keeps the singletons singleton: one Dock icon, one updater,
one CLI socket and token store, one menu-bar item.

Crash containment is the only argument the other way and it is weak. A Rust
panic takes down the shared PTY host either way, since the PTYs are its
children. A webview crash is already contained without help: WKWebView runs
each webview in its own WebKit content process, so one window's JS blowing up
cannot touch another's.

## Cross-window sync

This is the one genuinely new cost, and it exists because Spaces share data
rather than isolating it. A rename in one window must reach the others.

It is bounded. Rust already owns `projects.json` and `tasks/*.json`, and every
mutation already goes through a Tauri command, so the shape is "after a
mutating command, emit a change event; windows reload the affected entity."
One layer, uniform.

Crucially these are user-speed events. Live titles and agent state are
PTY-driven, stay per-window, and never cross. Nothing here touches the hot
path, and the bail-on-unchanged discipline (performance.md bear trap 8) still
applies to each window's own store writes.

## Scoping: the filter has to apply everywhere, or it leaks

A Space is a filter, not a boundary. The personal project is still in the
store in the work window; it is merely not shown. Scoping only the sidebar is
not enough, because the leak then surfaces at exactly the wrong moment, in
front of a shared screen.

The active Space must scope, at minimum: the sidebar project list, the
command palette, search, and whatever the CLI lists by default. The menu-bar
item is the deliberate exception (see below).

Say plainly in the docs and the UI that this is a view, not a security
boundary. Anyone wanting real separation wants two machines or two accounts,
and termic should not imply otherwise.

## The menu bar item

The attention menu (`build_tray_menu` / `tray_set_attention` in
`src-tauri/src/lib.rs`, fed by `src/lib/trayAttention.ts`) is the one surface
that legitimately sees every Space at once, and it should keep doing so:
knowing an agent needs you in the other window is the whole reason it exists.

Two consequences, both smaller than they were under the profiles design:

- **The push stays as-is.** Every window computes from the same global task
  set, so all windows push identical payloads. Redundant, not conflicting, and
  no merge map is needed. Group rows by Space above the existing per-project
  headers so it reads as "which window is this in."
- **Clicking a row must route.** The handler does
  `app.emit("termic://focus-task", task_id)`, which every window receives
  (`src/lib/windowlessMode.ts`). With N windows only the owning Space's window
  should act and be raised, so this becomes `emit_to` against the window
  derived from task → project → Space.

`enter_windowless` / `leave_windowless` hardcode
`app.get_webview_window("main")`, and `WINDOWLESS` is a single `AtomicBool`.
With `space-<id>` labels, "windowless" is true only when NO window is up. That
flag gates the activation-policy drop to Accessory, and the menu-bar item is
the only way back from it, so a one-window check would drop the Dock icon
while another Space is still visible.

## Deep links and the CLI

Almost everything the profiles design needed here evaporates, because there is
one namespace again. Project and task names stay unique app-wide, `find_project`
(`src-tauri/src/cli_server.rs`) and `findProject` (`src/lib/deepLink.ts`) are
unchanged, and no `--space` flag or `TERMIC_SPACE` env var is required: a link
names a project, the project determines the Space, the Space determines the
window.

One real bug survives. `deep_link_take_pending` is a `std::mem::take` and the
nudge is a payload-free broadcast, so with N windows whichever webview drains
first swallows every queued URL, including ones for other Spaces. The
single-reader shape that makes double-handling impossible becomes a race.

The fix is now trivial rather than a claim protocol: Rust resolves the project
to its Space, hands the URL to that Space's window alone, and raises that
window. `queue_deep_link` currently calls `leave_windowless` before anything is
resolved, so the raise moves after the routing decision. If the owning Space's
window is not open, open it and then deliver.

## Where the UI goes

- **Space switcher: top of the sidebar, above the PROJECTS header.** Spaces
  are a sidebar concept and that is where projects live. It doubles as the
  window's identity label, which is what makes the accent color useful. Click
  opens a popover with create / rename / color / delete.
- **Compact rail (56px):** collapses to the Space's color tile and monogram.
  Identity, not controls, matching the rule set by hiding the project-list
  options trigger in the collapsed rail.
- **Reassigning a project:** drag it onto the switcher. The sidebar already
  has drag-into-group machinery with hover highlighting and `projectSetGroup`,
  so this reuses an existing shape.
- **Keyboard:** command-palette entries for switching Spaces, plus Cmd+1..9 if
  those are free (Cmd+N is not: it is "New task...", `src/lib/shortcuts.ts`).
- **Settings:** a Spaces section holding the short override list above,
  including the env map editor. Not a duplicated settings tree.
- **Menu bar item:** lists Spaces, so one can be opened with no window focused.

## Migration

- **One default Space containing everything.** Anyone who never creates a
  second notices nothing.
- **Existing `Project.group` values are the obvious seed** for initial Spaces,
  and this needs deciding either way (see open questions).
- **Worktrees never move.** Same reason the workspace→task migration refused
  to: CWD-resume agents (`claude --continue`) key sessions to the working
  directory, and relocating a worktree silently orphans its history. A Space's
  `repos_dir` applies to new tasks only.
- **One `settings.json`, so no fork and no divergent `schema_version`.**

## Costs and gaps to resolve before this becomes a plan

- **Closing a window with running agents.** PTYs live in Rust and survive, so
  the tasks become unmounted-but-running and the menu-bar item is their only
  surface. Reopening needs scrollback from somewhere, and how much Rust buffers
  for replay is unconfirmed. This is the most important gap, because
  long-running agents are the product.
- **Launch restore.** Which windows come back: every Space that was open, or
  only the last focused one? Interacts with the `space-<id>` window labels.
- **`Project.group` versus Space.** Space plus folder plus project may be one
  level too many. Either Space replaces `group`, or keeping both needs a
  justification.
- **Is a project in exactly one Space?** Recommended yes, or the grouping
  stops grouping, but it needs to be stated and enforced.
- **The perf budget multiplies.** N windows means N webviews and N WebGL
  renderers. `make perf` measures one window today. Decide the multi-window
  idle budget, and whether a background Space's window should aggressively
  unmount, remembering that `display: none` (never `visibility: hidden`)
  discipline applies per window, not just per pane.
- **Global UI on per-window webviews.** The update banner renders in every
  window off shared Rust state; the settings dialog grows a per-Space section;
  a clicked notification must focus the owning Space's window, so the notifier
  carries a Space id.

## Open questions

- Whether the env map should also be settable per project, or Space-only.
  Space-only is the smaller thing and covers the stated use case.
- Exact shape of "move this project to another Space" beyond the drag: whether
  a task's live PTY survives the move (it should, since the PTY is in Rust and
  the task's window changes) and what the window transition looks like.
- Whether per-Space custom agents are ever needed once the env map ships, or
  whether the env map absorbs the entire demand.

## What we considered and dropped

**Chrome-style Profiles (fully isolated instances).** The original version of
this doc. Each profile owned its own `projects.json`, `tasks/`, and
`settings.json`, with hard isolation between them. Dropped because every cost
traced to the isolation rather than to the windows, and the isolation is not
what was asked for. It required: a `profile:<id>:` namespace for localStorage
(the doc's own "single biggest hidden cost", since all windows share one
webview origin), independent `schema_version` migrations per profile, a
profile-scoped agents registry, per-profile CLI addressing, and a merge layer
in the tray. Six independent surfaces, in exchange for a boundary nobody
requested. The decisive argument was the first-run experience: a new profile
starts empty, so a user who wanted a second window gets a second installation
and configures Claude Code twice.

**Per-Space settings, in any form that forks the tree.** Same failure, smaller
blast radius. Replaced by the inherit-by-default override list, which reached
the same use cases (different `repos_dir`, different default agent, different
risk posture, work vs personal Claude Code) without duplicating anything.

**Per-Space agent registries.** Dropped in favour of the env map, which turned
out to cover the motivating case (work vs personal Claude Code is one binary
plus different environment) at a fraction of the cost. Kept as a possible later
overlay, explicitly not a second registry.

**Multiple windows per Space, Chrome-style.** Dropped. It forces either two
WebGL terminals on one PTY or scrollback replay on every move, and it would have
required a task-to-window ownership registry that one-window-per-Space makes
derivable instead. A single-mount rule (a task lives in one window, dragging it
moves rather than mirrors) was considered as the way to allow it safely, and
rejected as cost with no demand behind it.

**Routing deep links by last-focused window.** Considered, then rejected even
before Spaces replaced Profiles: focus is not where the link points, and the
existing code already refuses to guess (`findProject` treats an unknown project
as an error rather than falling back to the first one, and `parseOpen` names
ambiguous candidates rather than picking). Under one namespace the question
mostly disappears, since the project itself identifies the window.

**`TERMIC_PROFILE` as a CLI default, injected into every PTY.** Designed in
full, then dropped with the profiles model: it existed only because the CLI
would have had multiple namespaces to address. It also carried a genuine trap
worth remembering if anything like it is ever proposed again: tmux's server is
machine-global, so whichever pane starts it captures that value and every later
pane in any context inherits it, and `pty_spawn`'s env overlay does not help
because it fixes the direct child, not a server that outlives it.

**Treating a Space as a security boundary.** Rejected explicitly. The socket is
global and the CLI token is per-machine, so nothing stops one window's agent
from acting on another Space. Spaces are organizational. The sandbox is the
security boundary, and that separation should be stated in the UI so nobody
infers otherwise.
