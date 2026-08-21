# Stop hand-maintaining the language list

**Not decided.** The numbers below are measured; the trade is a judgement call
nobody has made yet.

Adding a language to the editor today is two edits: an entry in
`lib/languages.ts` (id, label, extensions) and a `case` in `lib/languageExts.ts`
returning its grammar. That is how Swift and Groovy/Gradle went in, and it cost
nothing extra because both are stream modes inside `@codemirror/legacy-modes`,
which is already a dependency. The obvious question is why a human is doing
this at all when CodeMirror publishes the list.

## What the registry is

`@codemirror/language-data` is a published array of `LanguageDescription`s —
roughly 150 languages, each with its extensions, filename patterns, aliases,
and a **lazy loader**:

```ts
const desc = LanguageDescription.matchFilename(languages, "build.gradle");
const support = desc && await desc.load();   // dynamic import, code-split
```

We do not have it installed. Today's `package.json` pins 15 individual
`@codemirror/lang-*` packages plus `legacy-modes`.

## Measured cost

Wired into `EditorPane` behind a live call site (a tree-shaken probe measures
nothing — the first attempt reported zero because rolldown dropped it), built
with `npm run build`, compared against the same build without it:

| | before | after |
| --- | --- | --- |
| main `index` chunk | 2300K | **2300K** (unchanged) |
| editor chunk (first file opened) | 604K | **644K** (+40K) |
| total `dist/` | 7208K | **8032K** (+824K, +11%) |
| JS chunks | 92 | 186 (+94) |
| new npm deps | — | 9 (`language-data` + 8 Lezer grammars we lack) |

Read it as three separate answers, because "does it make the bundle bigger"
has three:

- **App start pays nothing.** The registry is only reachable from the lazily
  loaded editor, so the main chunk does not move at all.
- **Opening the first file pays 40K** — the index itself: names, extensions and
  aliases for ~150 languages. That is the part that is always loaded.
- **The `.app` on disk grows ~0.8MB**, in 94 separate chunks, each fetched only
  when a file of that language is opened. Nothing is parsed for a language the
  user never touches. In a browser those bytes would never be downloaded; in a
  Tauri app they ship regardless, which is why this is a real cost rather than
  a free win.

## What it actually buys

Not raw coverage — most of that registry is backed by the same `legacy-modes`
package already on disk, so any of those languages is available today for two
lines. What it buys is **maintenance**: extensions, aliases and filename
patterns tracked upstream instead of by whoever notices, and a picker whose
list is the registry rather than a hand-written catalog. Plus the 8 Lezer
grammars we do not currently ship (PHP, Vue, Sass, Less, Liquid, Jinja,
Angular, WAST).

## What it does not solve

- **Makefile stays hand-written** (`lib/makeMode.ts`). Nothing upstream has a
  Makefile grammar — not the Lezer set, not the 150 legacy modes.
- **The proto3 patch stays** (`lib/protoMode.ts`): the shipped legacy mode
  predates proto3.

Both would be registered as extra `LanguageDescription`s alongside the
registry, so "the registry plus our two" is the end state, not "the registry".

## What changes in the code

The awkward part, and the reason this is not a one-line swap: **loading becomes
async.** `langForId` returns an `Extension` synchronously today and the editor
mounts with it. With the registry it returns a promise, so:

- The editor mounts with no grammar and reconfigures its language compartment
  when the load resolves. The compartment is already the live-switch mechanism
  (that is how Set-syntax works), so the machinery exists — but the mount path
  gains an await, and a fast tab switch must not let a resolved grammar land in
  a view that has since been rebuilt. That needs a cancellation guard and a
  test, and it is exactly the shape of async-mount race the no-StrictMode rule
  exists for.
- `EditTab.syntax` / the scratch index persist a language **id**. Registry
  names would become that id, so either they are stable enough to persist or a
  mapping layer is needed. Same question `docs/ideas/lsp.md` has about LSP's
  `languageId` strings — worth answering once, for both.
- The picker (`SyntaxPalette`) sources its rows from the registry, which is a
  straight simplification.

## The judgement

For 40K on the editor chunk and 0.8MB in the app, the win is that nobody has to
notice a missing language again. Against it: the current cost of adding one is
two lines, the long tail is already reachable through `legacy-modes`, and the
async mount is real work in a file where async races have bitten before.

Worth revisiting the moment a third "can you add language X" request arrives —
that is the signal that the maintenance argument has started to bite.
