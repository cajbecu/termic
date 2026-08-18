# UI

## Conventions

- Colors are `@theme` CSS vars in `index.css`. Accent terracotta `#d97757`, dark surfaces `#0a0a0a`-`#181818`. Never hard-code hex outside `@theme`.
- Ink on a solid **status/accent fill** must come from that fill's own `-fg` token, never `text-white`. On a `--color-accent` fill (count badges, filled CTAs, review-comment buttons, editor search checkmark, toggle knobs on an accent track) use `--color-accent-fg`; on a `--color-ok` fill (the AgentsSection toggle tracks) use `--color-ok-fg`. Do not reuse one for the other: a theme may pair a light accent with a dark ok. The accent is not guaranteed dark (cobalt sky 1.9:1, matrix green 2.5:1, rosepine rose 1.7:1 against white), so light-accent themes override the token to a dark ink. `--color-accent-deep` stays dark in every theme, so white text on it is fine, which is why the `:hover` states that drop to accent-deep flip back to white.
- `CliIcon cli={...}` + `CLI_BRAND_COLOR[cli]` for claude/gemini/codex (orange/blue/green).
- Tooltips default `delay: 0`. Override per-call.
- `cn()` from `@/lib/utils` for class composition.
- All `<input>` and `<textarea>` get `spellCheck={false}` + `autoCorrect="off"` + `autoCapitalize="off"` + `autoComplete="off"`. Developer tool — paths and commands are never English words.

## Settings layout

Left rail + one content pane (`components/settings/Settings.tsx`). Three bands, hairline-separated, then the per-project list:

1. **Opened by choice** (General, Appearance, Agents & Terminals)
2. **Set once** (Tasks, Notifications, Prompts, Shortcuts)
3. **The perimeter**, what the app is allowed to do (Sandbox, Termic CLI)
4. `PROJECTS`, the only band with a label, because it is a dynamic list needing an empty state

The bands are what the app looks like and runs, then how it behaves while you work, then what it is allowed to do. Sandbox sits low because of the last one, not because it matters least. General leads by convention rather than by that rule: it is app-level and set-once, but every settings UI opens on General and fighting that expectation costs more than the inconsistency does.

Appearance carries its own sub-tabs (Terminal, Editor, Interface) on the strip Settings → Projects uses. Terminal leads. Its live preview is a real `AuxTerminal`, so it is click-armed: a settings visit must never fork a shell on its own, and the pty dies when the tab unmounts.

Each page owns one domain, and a setting belongs to the page whose domain it changes, not the page that happened to be open when it was written. General is app-level only (repos directory, personal file-tree excludes, remote images in the markdown preview); it is deliberately short. A new setting that needs a fifth thing on General is a sign the domain wants its own rail item.

Sections share `Controls.tsx`: `Toggle`, `ListField`, `Block` (hairline + spacing), `SectionTitle`, and `useBackendSettings()`. Use the hook rather than calling `settingsLoad`/`settingsSave` directly: it caches the whole `Settings` object and merges patches into it, so one page saving one field cannot wipe another page's. Prefs (`store/prefs`) persist on change; backend `Settings` fields either persist on change through `patch()` or use an explicit Save button when the field is a multi-line list.

Deep links (`openSettings(tab, repoId, highlight)`) hard-code a tab name, so moving a setting between pages means updating its callers. Live ones: the markdown-preview banner (`general` + `load-remote-images`), the command palette's settings list, and the shortcuts help dialog.

### Experimental features

A feature is Experimental when it is off by default **because we are not yet confident in it**, with a stated way out. Off for safety (remote images), off for taste (copy on select), and off as policy (sandbox permission bypass) are none of them experimental: those defaults are permanent, and labelling them experimental makes the label meaningless.

It shows as a badge, on the rail item and next to the page title, not as a separate Labs page. The badge is dropped when the feature graduates: it survived a release with no bug reports against it and has e2e coverage. Graduating drops the badge and gets a changelog line; it does not move the page, because a settings page that moves twice is worse than one labelled honestly. A dedicated Experimental page only earns its place when several features qualify at once, which today they do not (there are no residents: the CLI graduated in 0.26.0, dropping the badge and flipping `cli_enabled` to default ON in the same change, since a badge that says "still settling" alongside a setting we ship enabled reads as a contradiction).

## Window chrome / drag

macOS overlay title bar, hidden title, 84px reserved left for traffic lights. Three drag mechanisms (each fails differently):

1. `data-tauri-drag-region` — primary (Tauri 2 JS handler)
2. `WebkitAppRegion: "drag"` — backup (native AppKit hint)
3. `onMouseDown → startDragging()` — escape hatch (imperative)

Opt-out with both `data-tauri-drag-region="false"` and `WebkitAppRegion: "no-drag"`. mousedown handler skips `button, input, [data-no-drag]`. `startDragging()` silently fails without `core:window:allow-start-dragging` in capabilities. No `user-select: none` on drag region — put it on inner text spans.

## Top-bar tooltips that name a shortcut

`CommandPaletteButton.tsx` opens the right-hand cluster in `UnifiedBar.tsx`, before Run and the rest of the task-scoped actions (a divider separates it from them), and renders with or without a task (the palette's global commands do not need one). The palette button is a bare icon (`SquareChevronRight`, the ">" prompt) matching its neighbours: the shortcut lives in the tooltip only, built from the LIVE `command-palette` binding via `bindingGlyphs` rather than a hard-coded "⇧⌘P", so a rebind retitles it. An earlier version printed the glyphs on the button face as a bordered chip, which read as a foreign element in a row of bare icons.

Prompts (⌥⌘P, the searchable palette over the same list) and the right-panel toggle (⌥⌘B) get the same treatment through the local `tipWithKey(text, id)` helper in `UnifiedBar.tsx`, which appends the live glyphs or nothing. Wrap the tooltip OUTSIDE a `DropdownTrigger asChild` (`<Tip><DropdownTrigger asChild><Button/></DropdownTrigger></Tip>`), and give that menu `onCloseAutoFocus={e => e.preventDefault()}` or the focus snapping back to the trigger re-fires the tooltip and leaves it stuck open.

The palette button toggles on `pointerdown`, not `click`, and that is load-bearing: the palette is a non-modal Radix dialog whose dismissable layer closes it on document pointerdown, so a click handler reading `commandPaletteOpen` always sees `false` and reopens what the user just dismissed. `onClick` remains as the keyboard path (Enter / Space fire no pointer event) and no-ops when pointerdown already handled the press.

## Dropping a path into a terminal

Two gestures, one landing point (`lib/terminalDrop.ts`): every terminal host registers itself with `registerTerminalDropTarget`, and a drop types the escaped path into that PTY through `ipc.ptyWrite` — indistinguishable from typing it.

- **From Finder** — Tauri's native `onDragDropEvent` (the DOM `drop` never fires, and WKWebView would not expose the real path anyway). Absolute paths, physical-pixel drop point. A drop on a **sandboxed** agent asks first: stage into TMPDIR, or allow the file/folder (needs an agent restart).
- **From the file tree** (GH #136) — a pointer drag (`startPathDrag`), same as the tab strip: **never HTML5 DnD**, which is unreliable in WKWebView and gets intercepted by Tauri's file-drop. Inserts the path relative to the task root (falls back to absolute for another task's terminal); no sandbox prompt, since the worktree is already granted.

Both share the hit test and the `.termic-drop-target` highlight, so they agree on where a drop lands.

## Close vs Quit (windowless mode)

Standard macOS app semantics, added as a prerequisite for the CLI's windowless daemon mode:

- **Close** (red button; ⌘W is "close active tab", not the window) → routed by the `close_action` setting. `CloseRequested` is ALWAYS prevented first, then Rust decides:
  - unset / `"ask"` (default) → emits `termic://close-requested`; `CloseDialog` asks **Keep in Menu Bar** / **Quit Termic**, with "Don't ask again" writing the choice back to `close_action`.
  - `"menubar"` → straight to windowless, agents keep running.
  - `"quit"` → teardown.

  Anything unrecognised falls back to **ask**, never to quit (`close_action_from`, unit-tested): a corrupt or hand-edited settings file must not be able to start killing agents.

  Settings › General exposes all three as a select. It has to include "Ask me each time", because ticking "Don't ask again" in the prompt is otherwise a one-way door.

  `CloseDialog` is deliberately NOT built on `ConfirmDialog`, which folds dismissal into cancel — whichever action sat on cancel would also fire on Escape. It has three outcomes instead, and **dismissal cancels the close entirely** (window stays as it was), so Esc can neither quit nor be the only route to quitting.
- **Quit** (⌘Q or the menu-bar item) → the only teardown path: `RunEvent::Exit` → `cleanup_children` SIGKILLs every PTY and script group.
- **Dock icon** click on a windowless app reopens it (`RunEvent::Reopen`). Unhandled before, but moot then: closing the window quit the app outright, so there was nothing to reopen.

This is a deliberate behavior CHANGE, not a bug fix. Previously closing the last window quit Termic and killed every running agent (tao destroys the window → Tauri fires `ExitRequested` → unprevented → exit). The teardown comment in `lib.rs` claimed the app survived a last-window close; that was wrong, verified empirically.
- **Menu-bar item** opens a menu on click (either button): **Show Termic** / separator / **Quit Termic**. No bare left-click "show" shortcut — that would leave Quit reachable only by right-click, which is undiscoverable for the one action that stops your agents. The separator keeps Quit off the muscle-memory path. It has no setting, deliberately. Its presence IS the signal "Termic is running without a window": shown when the window goes away, hidden on restore. A preference would only control whether it also sits there during a normal windowed session, which adds chrome and says nothing. `enter_windowless` refuses to drop the dock icon (`Accessory`) unless the item actually came up, so the app always has a way back.
- `termic`'s auto-launch passes `--headless`, which boots straight into windowless: no window, no dock icon. An instance that has never shown a window stays `ActivationPolicy::Accessory`; once the user has seen one, the dock icon persists for the process lifetime (Mail/Messages behavior).

The webview stays ALIVE while windowless — it owns PTY lifetime and every work-state signal, so tearing it down would kill the agents. It is not suspended (WebKit only clamps timers to 1 Hz). What windowless mode DOES have to do is collapse the task panes to zero geometry, or xterm keeps drawing for an invisible window: see docs/performance.md bear trap 2b and `src/lib/windowlessMode.ts`.

## Right-panel tabs (All files / Git)

**Git** is one tab with three sub-tabs, because they are three questions about
one repo rather than three places:

- **Commit** — what you can stage right now (Fork-style staging, the only one
  of the three you ACT in: stage, discard, commit, push).
- **Compare** — what this branch adds up to next to another ref (issue #208):
  one list of every path that differs between a chosen ref and the working
  tree, committed and uncommitted alike, because an agent that split a feature
  over six commits leaves nothing in the staging view to read.
- **History** — the commit graph (issue #199), full height.

Order of the chrome above them, outermost first: repo pills (multi-repo tasks),
then the branch bar, then the sub-tabs. Which repo you are looking at is what
the branch and all three sub-tabs are ABOUT, so it cannot sit inside them.

One box serves all three, on the branch row (the branch chip is one short
control on a full-width row, so it rides with it rather than spending a row of
its own). In Commit and Compare it filters the file list. In History it is a
MESSAGE SEARCH run by git (`--grep`, literal and case-insensitive, subject and
body) over the whole scope rather than over the rows on screen: "does this
branch have a commit about X" is a question about the history, and answering it
from the loaded page would make it a question about how far you had scrolled.
Debounced at 250ms, so it is one `git log` per pause. It narrows whatever scope
is active rather than replacing it, so a search under All searches every ref.

The sub-tab row keeps only what belongs to the active view: the view-mode menu
for Commit and Compare, the ref picker for History.

History's picker has two independent axes. WHICH refs to walk (Auto = the
checked-out branch, All = every ref, or any number of named ones) and HOW MUCH
of the topology: **First parent only** collapses a merged side branch into the
merge commit that brought it in. Without it, picking one branch still draws a
lane per merged branch, because those commits genuinely are its ancestors,
which reads as "why am I seeing other branches when I picked main".

The graph used to be a collapsible section at the foot of the staging view,
sharing the body by a draggable ratio. It is the one view here that wants
vertical space and was getting whatever two file lists left over, so it became
a sub-tab and the collapse flag, the ratio, the divider and their localStorage
keys went with it.

## Right-panel footer (Setup / Run / Terminal)

Three tabs. Setup + Run stream via `useScriptRuns`. Terminal is opt-in: click `+` → `useApp.enableFooterTerm(wsId)` → AuxTerminal mounts. RunToolbar: Open (expands `project.preview_url` with `$TERMIC_PORT`/`$CONDUCTOR_PORT`/`$PORT`/`$TERMIC_WORKSPACE_NAME`) + Run/Stop (SIGTERMs process group). Default: tab=Run, expanded.

`task_archive` sweeps `RUNNING_SCRIPTS` and SIGTERMs each before teardown.

## Inline review comments (two surfaces)

`reviewCommentsExtension(taskId, file, surface)` is one component with two loudness settings, because the same gesture means different things in the two places it runs.

- **Diff pane** (default `{ selection: "pill", hoverGutter: true }`) — reviewing IS the job, so a selection raises a labelled "＋ Comment on lines 12-40" pill and every line offers a hover button.
- **Code editor** (`{ selection: "gutter", hoverGutter: false }`) — you are reading and typing, so both of those read as a second cursor. One dim gutter icon, on the selection's first line, only while a selection stands. ⇧⌘L is the keyboard route (see [shortcuts.md](shortcuts.md)).

The composer has two exits, because a remark on code is sometimes the whole thought and sometimes one of five:

- **Send** (accent CTA, also ↵) ships THIS one immediately and never touches the queue. The comment body is optional there: the selected code alone is a legitimate message.
- **Add to pending** queues it. Queued remarks from the editor and the diff share one list (both key by `file`), and the pending-comments bar sends the batch as ONE message.

Both routes go through `sendCommentsToAgent` (`lib/sendComments.ts`) — one delivery path, so target resolution, the `lastInputAt` stamp that re-arms work-done detection, the focus handover and the toast cannot drift between the two entry points. Editing an already-queued comment offers Update only: it is in the queue, and the bar is where a queue gets sent. Every message carries the fenced code, not just a location line.

The editor's gutter column collapses to zero width while there is nothing to put in it (no selection, no comments for the file). A gutter costs its width on every line forever, and an editor is read far more than it is commented on — 20px of permanent horizontal room made files, markdown especially, start scrolling sideways sooner than they used to. The diff keeps a fixed column: it shows a button on every hover, so a width appearing and disappearing under the mouse would be worse than the space.

While an editor is open, each queued comment keeps the actual selection it was made on as document offsets, mapped through every edit (`lib/commentAnchors.ts`) and written back to the store debounced. Type three lines above a queued comment and its stored range follows the code instead of pointing at whatever now occupies the old line number. The association pair is deliberate: `from` maps with +1 and `to` with -1, so the range does not swallow text typed at its edges. Note the anchor tracks the BUFFER; comment on unsaved edits and the agent, which reads disk, sees something different.

## Inline git blame (cursor line only)

`inlineBlameExtension(taskId, path, { onOpenCommit, onShowInHistory })` annotates the line the cursor is on with `subject, Author (age)` in dimmed text, 50px after the code. VS Code's `git.blame.editorDecoration`, and the format is VS Code's default template with `commitAge` supplying the age so the editor and the History panel describe the same commit the same way.

**The annotation itself is inert.** It sits inside the line being edited, where a click target competes with placing the cursor, so it is hover-only. Resting on it for `CARD_DELAY_MS` (500ms) opens a hover card: long enough that crossing the annotation on the way somewhere else does not throw a card over the next line, short enough that resting on it feels answered.

The card carries author, relative age AND absolute date (the first answers "is this recent", the second "which release"), the short sha, co-authors, the subject in full, and the message prose. Its header holds the two actions:

- **Open diff** — this file as that commit changed it, in the `commit:<sha>` diff tab the History panel already uses.
- **Show in History** — `revealCommitInHistory(taskId, sha)` on the UI store. RightPanel opens the Git tab (and un-hides the panel), GitPanel switches to the Graph, HistoryPanel selects, expands and scrolls to the sha. Three consumers of one request, because the editor has no handle on any of them.

  Two things about that request are load-bearing:

  - **It is CONSUMED.** `clearCommitReveal()` once honoured, plus an `at` timestamp each consumer records so it acts on a request once. Left standing it is a standing order: RightPanel's effect depends on the active task, so it re-fires on every task switch and re-pins the panel to the Git tab. That is not theoretical, it cost most of a debugging session and broke two unrelated e2e specs.
  - **A commit that is not loaded is JUMPED to, not paged to.** `task_git_commit_offset` asks git how far back the sha is (`rev-list --count <sha>..HEAD`) and the panel fetches the single page around it, replacing the window rather than appending (the rows above belong to a different part of the history, and stitching them would draw a graph with a hole in it). Paging forward until the sha appears works on a young repo and is hopeless on a monorepo, where a two-year-old commit is tens of thousands of rows down. A sha that is not reachable from HEAD says so in a toast and drops the request.

The card is a CodeMirror tooltip (`showTooltip`), so CodeMirror owns positioning, flipping and clipping. Two things had to be told about the geometry, and both were visible bugs first:

- **`tooltips({ tooltipSpace })` in EditorPane**, constraining every tooltip to the editor pane's own rect. CodeMirror's default is the whole document viewport, so a card anchored at the end of a long line ran under the right panel and one near the top ran under the tab bar. Mounted in EditorPane rather than in this extension because the review-comment tooltip wants it too.
- **A `min-width` on the card**, not just a max. The annotation sits at the end of a line, so there is often only a sliver of room to its right; with no minimum the card shrink-to-fit into that sliver, wrapped its header into a column and drew its buttons over the author line. Given a width it cannot fit, CodeMirror shifts it left instead, which is the wanted behaviour. It has to survive the pointer travelling into it or its buttons are decoration, hence `CARD_CLOSE_MS` (220ms) of grace on leaving the annotation, cancelled when the pointer arrives in the card. Any edit closes it: the card describes a line that is moving under it.

The message body is NOT part of the blame payload. A file's blame can name 169 distinct commits and the reader looks at one, so `task_git_commit_meta` fetches the body when a card opens, cached per sha. The header renders immediately from the blame data and the prose fills in when git answers, rather than the card waiting on a fork before showing anything.

There is deliberately **no blame column**. Annotating every line is a layout cost, not a cosmetic choice; the reasoning and the CodeMirror rule behind it are bear trap 10 in [performance.md](performance.md).

The pref is `inlineBlame`, OFF by default (matching VS Code's own default and the opt-in shape `loadRemoteImages` set), in Settings → Appearance → Editor, and in the command palette as "Toggle inline git blame" with its current state as the row suffix. It is mounted through its own `Compartment`, so toggling reconfigures in place: cursor, undo history and scroll position all survive, and with it off the extension is never constructed, so nothing is fetched and no state field exists.

Two honesty rules, because a confidently wrong author is worse than none:

- **A line the user edited loses its attribution** and reads "Not committed yet". Mapping alone does not achieve that: `MapMode.TrackBefore` drops a line joined onto the one above, but the survivor keeps its own mark, so the merged line would be credited to whoever owned the first half. Every line an edit touched is filtered out of the snapshot as well.
- **A dirty buffer is never re-blamed.** Blame reads the file on DISK, so its line numbers would not match the screen. The save and external-reload paths drop the cache entry and dispatch `refreshBlame`, which is when a re-fetch happens.

A git tick is deliberately NOT a re-fetch. `gitRevision` bumps on every stage and unstage, not just on commits, so it dispatches `markBlameStale`: the annotation on screen stays put and the refetch rides the reader's next cursor move. Re-blaming per tick forks git once per open editor to redraw one line that usually did not change, and it measurably slowed the e2e suite when it was written that way.

## Settled detection / notifications

TerminalPane samples `term.buffer.active` every 3s, FNV-1a hashes the visible viewport, marks tab "settled" after 2 identical consecutive samples. Resets on user input. `markAttention(wsId, tabId, reason)` never marks the active tab in the active task. `useAttentionNotifier` suppresses OS notifications for every tab in the focused task. Desktop notifications off by default. Clicking a banner only brings the window forward: it never changes the active task or tab (the old focus-edge router jumped on any refocus within 15s of a notification, including a plain cmd-Tab). The unread dot is what points at the tab; the user does the switching.
