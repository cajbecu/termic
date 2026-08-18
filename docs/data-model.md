# Data model

## Directories

Three directories, different owners:
- `~/Library/Application Support/termic/` — app-owned: `projects.json`, `tasks/`, `settings.json`. Path via `dirs::data_local_dir().join("termic")` in `lib.rs#data_dir()`.
- `~/Library/Application Support/com.simion.termic/` — tauri-plugin-window-state owned (window position/size). Path from `tauri.conf.json#identifier`.
- `~/.config/termic/themes/` — user-owned, hand-authored custom theme files ([docs/themes.md](themes.md)). `$XDG_CONFIG_HOME` respected; shared by release + dev builds (no `termic_dev` split). Path via `lib.rs#themes_dir_path()`.

## Entities

- **Project** (`projects.json`, single JSON array) — git repo path + scripts + `preview_url` template + `files_to_copy` globs + `default_cli` + `extra_named_ports` (personal env-var-name list for GH #196, unioned with the repo's committed `.termic.yaml` `extra_named_ports`; yaml order first, deduped, invalid/reserved names dropped — see `effective_extra_named_ports`) + optional `group` label (UI-only collapsible folder in the sidebar; no filesystem effect; a group exists iff ≥1 project carries the label. All group reads go through `groupOf()` in `src/lib/projectGroups.ts`, THE normalization point: trim + ALL-CAPS, so mixed-case labels on disk converge to one group. Collapse state + folder color live in `localStorage` keyed by normalized name, pruned when a group disappears).
- **Task** (`tasks/<uuid>.json`) — git worktree branched from project's `base_branch`. Worktrees live at `~/termic/tasks/<project>/<name>/` by default (configurable per project and globally). `is_main_checkout=true` tasks point at the project's live checkout (no worktree, archive skips `rm -rf`). Optional `order` holds the sidebar position within the project, written by drag-to-reorder (`task_reorder`). Projects get their order from the `projects.json` array; tasks are a file each, so they need the explicit key. `load_tasks` sorts on `(order, created)` with a missing `order` LAST, which is why a project nobody has dragged still reads oldest-first and a new task appends at the bottom of a reordered one. Each task also owns a consecutive **port block** (GH #196), allocated at create by `allocate_task_ports`: `port` ($TERMIC_PORT) + one port per composition member (base+1+i) + `extra_named_ports` (frozen name→port pairs from the project's effective list, injected wherever TERMIC_PORT is set and expanded in the preview URL) + a 5-port buffer. The block length is stored on the task (`port_block_len`) at allocation; blocks first-fit from 18100 over non-archived tasks (archived blocks are reused; restoring re-homes a block another task claimed meanwhile). This replaced the old `18100 + task count` formula, which could collide with multi-repo member ports. Names added to the config LATER reach existing tasks lazily: every tab spawn / run-script launch calls `top_up_extra_ports`, which freezes missing names into the task's buffer slots, overflowing to the next free single port anywhere once the buffer is full (`task_port_intervals` counts those strays as occupied for all later allocations; a restore re-home re-compacts them into a fresh contiguous block). Frozen pairs never move; names removed from the config keep injecting. Pre-existing tasks deserialize with an empty pair list and pick names up the same way.
- **Settings** (`settings.json`) — `repos_dir`, `welcomed`, `agents[]` (claude/gemini/codex defaults + customs; each has `command`/`args`/`yolo_args`/`runtime_yolo_command`). Defaults seeded if `agents` is empty. `schema_version` gates one-time on-disk migrations.
- **Tab** (per task, in `useApp`) — `terminal` (PTY running a CLI), `edit` (CodeMirror), `diff` (vs HEAD). PTYs die with the app.

## Migrations

The "Task" entity was called "Workspace" before, on disk and in code. A one-time
startup migration (`migrate_workspaces_to_tasks` in `lib.rs`, gated by
`settings.schema_version`) renames the metadata dir `workspaces/` → `tasks/` and
rewrites the `is_repo_root` field to `is_main_checkout` (serde `alias` still reads
the old name). It is **metadata-only**: it deliberately does NOT move worktree
directories or rewrite each task's `path`. CWD-resume agents (Claude Code's
`--continue`) resume the most recent session by working directory, so relocating a
worktree would silently orphan its history. Existing worktrees stay under
`~/termic/workspaces/…`; NEW worktrees are created under `~/termic/tasks/…`
(`default_worktrees_base()`), and the two roots coexist while the old one empties out
lazily as tasks are archived/recreated. The metadata rename is atomic (stage in
`tasks.tmp/`, then one `rename` into place), guarded by a `tasks-migration.lock`,
backs up to `backups/pre-tasks-<ts>/`, and prunes-on-corruption (an unparseable
record, or an active worktree whose dir was deleted externally, is dropped +
logged to `tasks-migration.log`, never carried forward). The JS half
(`src/lib/lsMigration.ts`) renames the persisted `localStorage` pref keys
(`workspaceExpandMode` → `taskExpandMode`, `collapsedWorkspaces` → `collapsedTasks`,
plus the two `newWorkspaceLast*` keys); everything else in `localStorage` is keyed
by task UUID, which never changes.
