# Keyboard shortcuts

## Architecture

`src/lib/shortcuts.ts` is the single source of truth: `ShortcutId` union + `SHORTCUT_DEFS` (each: `id`, `label`, `group`, optional `hint`, `defaultBinding`). A `Binding` is `{ cmd, shift, alt, key }` where `cmd` folds Cmd=Ctrl, `key` is a normalized token or `"1-9"` sentinel.

**Adding a shortcut** = new `ShortcutId` + `SHORTCUT_DEFS` entry + `case` in `useShortcuts` (for global ones). Help modal and settings editor are data-driven from `SHORTCUT_DEFS`.

## Runtime

- **Resolved bindings** in prefs store (`usePrefs(s => s.shortcuts)`): `DEFAULT_BINDINGS` merged with localStorage overrides. Mutate via `setShortcut`/`resetShortcut`/`resetAllShortcuts`.
- **Global handler** (`src/hooks/useShortcuts.ts`): one `keydown` listener, matches via `bindingMatches(e, binding)`.
- **Contextual shortcuts** (need component state) handled inside the component with a capture-phase listener that `stopPropagation`s only when it claims the key. Shared chord meaning different things by context is expected, not a bug.
  - A component that stays MOUNTED while off screen (every visited task, every open tab) must gate that listener on an app-wide claim, not "am I laid out". Several instances answer the latter yes at once, and capture + `stopPropagation` means the loser doesn't just misfire, it eats the chord from whoever should have had it. Store state can't finish the job either: it doesn't model the bottom split, the right panel, or a modal on top. See the ⌘F bullet in [gotchas.md](gotchas.md#reactzustand-traps).
- **Help modal** (`ShortcutsHelpDialog`, triggered by `open-shortcuts`): read-only, grouped by `GROUP_ORDER`. Edit button jumps to Settings → Shortcuts.

## Code navigation keys

The five editor jumps (`go-to-definition` F12, `find-usages` ⇧F12,
`go-to-implementation` ⌥⇧B, `go-to-type-definition` ⌥⇧T, `file-structure` ⌘F12)
are ordinary `SHORTCUT_DEFS` entries, so they appear in the help sheet and in
Settings → Shortcuts like anything else. They were five literal key strings in
a CodeMirror keymap: they worked for whoever already knew F12, could not be
found, and could not be changed.

They stay a **CodeMirror keymap** rather than moving to the window handler,
because they must fire only while an editor has focus (F12 in a terminal
belongs to the terminal). `bindingToCmKey` converts a `Binding` into
CodeMirror's notation, and the keymap is built per editor mount, so a rebind
takes effect on the next open rather than instantly.

Two defaults are deliberately NOT IntelliJ's. ⌥⌘B (its go-to-implementation)
already toggles the right sidebar here, and the editor's copy fired on top of
it; the duplicate-chord test in `shortcuts.test.ts` is what surfaced that. ⌃⇧B
cannot be expressed at all, because a `Binding` folds Ctrl into Cmd and it
would read as ⌘⇧B on a Mac.

**F12 needs no modifier**, which is why `isValidBinding` exempts F1-F20: a
function key types nothing, so it cannot swallow input.

They live in their own **Code navigation** group, named after the feature and
therefore after the type-checking switch (`groupLabel` in
`ShortcutsHelpDialog`). Back / Forward stay in Navigation: they walk a folder
listing's trail as well as the symbol trail, so filing them here would describe
half of what they do.

## Shortcuts that cannot be rebound

`FIXED_SHORTCUTS` is a small separate list for gestures that are not a chord.
Double-Shift (Search everywhere) is the only entry today; it is handled in
`useShortcuts` through `lib/doubleTap.ts`.

They are deliberately NOT in `SHORTCUT_DEFS`: everything there has a `Binding`,
and the bindings map, the conflict check, the Settings recorder and the
localStorage migration all assume one. A def without a binding would need a
special case in each.

Both surfaces render them read-only, with their keys spelled out literally and
a word where the recorder would be ("Double tap"). Shown rather than hidden,
because a reader looking for "how do I open Search everywhere" reads its
absence as the app not having it.

## Back and Forward (⌘[ / ⌘])

One chord, one idea: go back to where you just were. It used to mean three
things chosen by where focus happened to be (switch task, walk a folder
listing's trail, retrace a symbol jump), with the two histories claiming it
conditionally on top of task switching and each carrying an escape hatch so it
"never silently stole" the key.

All of that machinery existed to protect task switching, which ⌥⌘↑ / ⌥⌘↓
already do and do inside a split too (tabs have ⇧⌘[ / ⇧⌘]). Removing it removed
the conditionals with it: the handler is now the folder listing if it has
somewhere to go, else the symbol jump trail, else nothing. A key that quietly
changes which task you are looking at once a history runs out is how people
lose their place.

The listing goes first because it is the more local history and the one you can
see. `dirHistoryTarget` (pure, unit-tested) decides which listing may claim it
from DOM-focus facts, rather than that logic living inline in the handler.

The ids are `nav-back` / `nav-forward`. They were `task-prev` / `task-next`, and
before that `workspace-prev` / `workspace-next`; `lib/lsMigration.ts` carries a
user's rebind across both renames.

## Glyphs

`bindingGlyphs(b)` returns `["⌥","⇧","⌘", key]`. Help modal uses raw glyphs (⌘ ⌥ ⇧); settings editor uses `glyphLabel` (Cmd/Ctrl, Option/Alt). `isValidBinding` requires Cmd/Ctrl or Option to prevent swallowing normal typing. The top-bar command-palette button (docs/ui.md) builds its tooltip the same way, so a rebind retitles it.

## Prompt palette (⌥⌘P)

`prompt-palette` (default ⌥⌘P) is a plain single-chord shortcut that opens `PromptPalette.tsx`: a searchable list of enabled prompts (fuzzy-filtered by title only). Enter runs the highlighted one; while the query is empty, digits `1-9` fire the top rows directly (a positional accelerator, Raycast-style, not a persisted per-prompt key). Firing goes through `fireOrPickDestination` in `src/lib/promptFire.ts`, which sends straight to the focused agent tab or falls back to the shared destination-picker dialog (`PromptDestinationDialog.tsx`) when there's no focused live agent. The Prompts dropdown in `UnifiedBar.tsx` always opens the picker so you can tweak the body and choose a target.

## Add selection to agent (⇧⌘L)

`add-selection-to-agent` is contextual, not global: it has no `case` in `useShortcuts`. `EditorPane` owns it, and answers only when the selection is non-empty AND the editor either holds DOM focus or is the visible active tab (`focused ? focused !== v.dom : !isActive`) — the two are mutually exclusive, so two mounted editors can never both fire on one press. With no selection it does not `preventDefault`, so the chord falls through untouched.

⇧⌘L is what the agent-first editors converged on for this action (Cursor's "Add selection to Chat", VS Code Copilot's "Add Selection to Chat"; Zed uses ⌘>), and it sits next to termic's own ⌘L "focus main agent".

It does not send anything. It opens the review-comment composer (`dispatchSelectionComment` in `reviewCommentsExt.ts`) on the selected lines — the same surface the diff pane uses, so editor remarks queue in the `reviewComments` store alongside diff ones and go to the agent as ONE batch from the pending-comments bar. The pointer route is the gutter icon that appears next to a selection (the diff's labelled pill stays on the diff, see [ui.md](ui.md#inline-review-comments-two-surfaces)). Both paths land in the same place; neither writes to a PTY on its own.
