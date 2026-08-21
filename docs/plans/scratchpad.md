# Scratchpad tabs (GH #244)

Sublime-style untitled buffers, inside termic. Open one from the tab strip,
type a note, and it is still there after a relaunch — without ever choosing a
filename, and without a stray file appearing in `git status`.

## The rule everything else follows

**A scratchpad is an unsaved buffer that happens to survive restarts.**

It is NOT a file with a hidden path. ⌘S does not write to the scratch store: it
**promotes** the buffer to a real file inside the project (pick a folder, pick
a name), after which it is an ordinary `edit` tab and the scratch record is
gone. Getting this backwards — having ⌘S quietly write to `~/…/scratch/` — is
the one way to ruin the feature: the user's muscle-memory save would report
success and file the note somewhere they will never look again.

Two consequences that read as contradictions until you hold the rule:

- **Quitting keeps your pads. Closing one asks.** A relaunch restores every
  open pad untouched; closing a tab prompts *Save… / Discard / Cancel*, and
  Discard deletes the pad. Same as Sublime, and it is what the issue thread
  asked for. Persistence covers the relaunch case, not the explicit close.
- **A pad is dirty for its whole life.** The dot on the tab is honest: nothing
  has been saved anywhere the user chose. The debounced write to the scratch
  store below is crash safety, not saving, and must not clear the dot.

## Storage

Real files under the Rust `data_dir()` (`src-tauri/src/lib.rs`), never inside
the worktree — a scratch file in the repo shows up in `git status`, in the diff
the agent reviews, and eventually in a commit.

```
<data_dir>/scratch/<projectId>/index.json     one record per pad
<data_dir>/scratch/<projectId>/<scratchId>.txt  the buffer
```

`index.json` holds, per pad: `id`, `title`, `syntax`, `taskId`, `order`,
`createdAt`, `updatedAt`. Title and syntax have to survive a relaunch and there
is no filename to re-derive them from, and one index read beats stat-ing N
files on launch.

**Scoped to the PROJECT, not the task.** This is the direct answer to the
objection in the issue thread ("they will stick to one session… the task
accidentally disappears"): a note about work that outlives a task must outlive
the task. `taskId` is recorded so the pad reopens in the tab strip it was last
used in, but archiving that task must not delete it. Concretely: pads may not
be keyed by task in any map that `loadAll`'s prune walks (the trap
`store/fileViewed.ts` documents in [gotchas.md](../gotchas.md)).

## Rust commands

All async (`spawn_blocking`), per the IO rule in [ipc.md](../ipc.md).

| command | does |
| --- | --- |
| `scratch_list(project_id)` | the index, ordered |
| `scratch_read(project_id, id)` | buffer contents |
| `scratch_write(project_id, id, content)` | create-or-overwrite the buffer, stamp `updatedAt` |
| `scratch_set_meta(project_id, id, {title, syntax, task_id, order})` | index-only update |
| `scratch_delete(project_id, id)` | drop buffer + record |
| `scratch_promote(project_id, id, task_id, rel_path)` | write the buffer to a task-relative path, then delete the pad |

`scratch_promote` is one command on purpose: promotion must resolve the target
through the same `resolve_task_git_path` + `safe_task_path` pair every other
write uses (so member dirs work and nothing escapes the worktree), and doing it
as "read here, write there" from TypeScript would re-implement that rule in the
one place it must not be re-implemented.

## Frontend model

Add `"scratch"` to `TabType` (`src/lib/types.ts`) with its own interface:

```ts
export interface ScratchTab extends BaseTab {
  type: "scratch";
  scratchId: string;
  projectId: string;
  /** Manual "Set syntax" pick. PERSISTED here, unlike EditTab's session-only
   *  one: a pad has no extension to re-derive from. */
  syntax?: string;
}
```

A new type rather than an `EditTab` with an empty `path`, because `EditTab.path`
is load-bearing in places a pad must opt out of — inline blame, review
comments, the on-disk-changed banner, "locate in file tree", the breadcrumb.
Making it a distinct type turns every one of those into a compiler error to
answer rather than a runtime surprise.

**Reuse EditorPane, do not fork it.** Give it a `source` prop:

```ts
type EditorSource =
  | { kind: "file"; taskId: string; path: string }
  | { kind: "scratch"; projectId: string; scratchId: string };
```

`kind: "scratch"` swaps `taskFileRead`/`taskFileWrite` for the scratch IPC and
turns off blame, review comments, and the disk-watch reload (`fsRevision` /
window-focus). Everything else — the CodeMirror setup, the theme and language
compartments, find, ⌘S binding — is shared. A second editor component would
drift from the first within two releases.

## Behaviour

**Creating.** The tab strip's "+" menu gains a "Scratchpad" row
(`NewTabMenuItems.tsx`, which the sidebar task row's New submenu also renders,
so both entry points get it), plus a command-palette row. ⌘N is already new-task
(`lib/shortcuts.ts`), so the shortcut is a new rebindable id (⌥⌘N by default),
not a steal.

**Titling.** Derived from the first non-empty line, trimmed to ~40 chars;
"Untitled" while empty. Debounced (~500ms) and **bailing when unchanged** — this
runs on the typing path, which is exactly [performance.md](../performance.md)
bear trap 8. A double-click rename sets `customTitle` and stops derivation, the
same lock that keeps OSC titles from steamrolling a renamed terminal tab.

**Syntax.** A pad has no path, so `languageIdForPath` returns null and the
content sniffer (`lib/detectSyntax.ts`) answers instead; the Set-syntax picker
overrides it. Both already shipped (9f8b487) and need no changes — only the
persistence of the manual pick in the index.

**Saving (the defining flow).** ⌘S opens an in-app "Save to project" picker:
the task's folder tree plus a filename field, prefilled with a slug of the
derived title. Deliberately NOT the native save panel — the requirement is
*inside the project*, and a native panel can write anywhere. On confirm:
`scratch_promote`, the tab becomes an `edit` tab on that path, then
`bumpFsRevision` + `bumpGitRevision` so the file tree and Git panel notice.
An existing file at the target asks before overwriting.

**Closing.** Route through `lib/closeTab.ts` — it is already the single close
path for the strip ×, pane ×, and ⌘W, and it already special-cases dirty edit
tabs. A pad needs a THREE-way prompt (Save… / Discard / Cancel), which today's
`askConfirm` cannot express; extend it with an optional third action rather
than hand-rolling a second confirm dialog.

**Restoring.** From the project's scratch index on launch (each record carries
`taskId` and `order`), NOT from `persisted_tabs` — that record is agent-tabs-only
by construction and pads are project-owned, not task-owned. Trade-off accepted
for v1: a pad restores into its task's main strip, and split-pane position is
not remembered.

## Traps

- **Never set `preview: true` on a scratch tab.** `openPreviewTab` recycles the
  first tab it finds carrying that flag, and recycling a pad would silently
  retarget it at a file (see the same function's `syntax`/`syntaxAuto` reset).
- **The debounced buffer write and the title derivation are both on the typing
  path.** Debounce both, bail on unchanged, and never write an unchanged value
  through a store setter (bear trap 8).
- **`data_dir()` is also the e2e profile.** `scripts/e2e-seed.mjs` and
  `wdio.conf.ts`'s `onPrepare` must sweep `scratch/` the way they sweep
  `tasks/`, or pads leak between local runs and specs start seeing each other's
  notes.
- **Archiving a task must leave its pads alone.** Assert it.

## Testing

- **Unit (vitest):** title derivation (first line, truncation, empty buffer,
  unchanged-bail), index round-trip, and the tab-type guards that keep blame /
  review comments / disk-watch off a scratch source.
- **Rust (`cargo test`):** scratch CRUD, and `scratch_promote`'s containment —
  a `rel_path` that escapes the worktree must be refused, including through a
  member dir.
- **e2e (new `scratchpad.e2e.ts`):** create from the + menu → type → the tab
  title follows the first line → the syntax button names what the content
  sniffer picked → ⌘S opens the picker → save → it is an `edit` tab on a real
  path, the file exists on disk, and the Git panel lists it. Plus: closing with
  Discard removes the pad, and closing with Cancel keeps the tab. Restore
  across a relaunch is a store-level test, not an e2e one — the suite shares a
  single app launch.

## Out of scope for v1

Split-pane pads and pane-position restore; global (cross-project) pads; the
checklist / task-tracker evolution floated at the end of the issue; anything
that syncs pads between machines.
