# Language support from the filename, with no per-language edits

**Approved.** Cost accepted (measured below). This replaces the hand-maintained
language catalog with CodeMirror's published registry, so opening a file of
*any* language it knows lights up without anyone editing termic first.

Today adding a language is two edits — an entry in `lib/languages.ts` and a
`case` in `lib/languageExts.ts`. That is how Swift and Groovy/Gradle went in.
After this, neither file has a per-language list to add to.

> **Revised before implementation.** The first draft of this plan asserted that
> `LanguageDescription.matchFilename()` covered our existing filename rules. It
> does not: checked against `@codemirror/language-data@6.5.2`, four of the six
> cases this plan's own test list calls "must survive" match nothing, and
> extension matching is case-**sensitive**. The corrected shape is below. The
> honest summary is that the per-language catalog goes away and a much smaller
> **overlay** of filename rules stays.

## What "automatic" means, precisely

Matching is **by filename**, which is both halves of what that implies:

- **Extension** — `.swift`, `.gradle`, `.php`, `.zig`.
- **Whole-filename patterns** — `Dockerfile`, `Makefile`, `justfile`,
  `.env.production`.

Two things stay in front of it, unchanged:

1. **A manual "Set syntax" pick** still wins over everything.
2. **The content sniffer** (`lib/detectSyntax.ts`) still answers when the
   filename says nothing — an extension-less file, and every scratchpad
   (GH #244), which by definition has no filename at all.

## The registry

`@codemirror/language-data`: ~150 `LanguageDescription`s, each carrying its
extensions, filename patterns, aliases, and a lazy loader.

```ts
const desc = matchLanguage("build.gradle");     // our wrapper, see below
const support = desc && await desc.load();      // dynamic import, code-split
```

### `matchFilename` is not usable as-is

Two defects, both verified against the shipped source:

- **Extension matching is case-sensitive.** `matchFilename` does
  `/\.([^.]+)$/.exec(filename)` and then `d.extensions.indexOf(ext[1])`. No
  lowercasing anywhere, so `README.MD` matches nothing.
- **Filename regexes are narrow.** `Dockerfile` is `/^Dockerfile$/`, anchored
  both ends, so `Dockerfile.dev` misses.

So `lib/languageExts.ts` exports its own `matchLanguage(path)`: filename
regexes first, then the **lower-cased** extension, over a composed list. Ten
lines, and it is the only place the precedence lives.

### The composed list

`[...CUSTOM, ...OVERLAY, ...registry]`, deduped by name for the picker, with
first-match-wins for filename resolution so ours beat the registry on a tie.

**CUSTOM** — languages the registry cannot serve at all:

| name | why |
| --- | --- |
| `Makefile` | nothing upstream has a Makefile grammar (`lib/makeMode.ts`) |
| `ProtoBuf` | the registry's mode predates proto3 (`lib/protoMode.ts`); same name, so it *replaces* rather than shadows |
| `Elixir` | not in the registry at all; `codemirror-lang-elixir` is already a dep and `.ex`/`.exs` highlight today |

Elixir was missed by the first draft, which said "our two extras". It is three.

**OVERLAY** — filename rules the registry lacks, each reusing the registry
entry's own loader so no grammar is duplicated. Every row here is a case that
works in termic today and would silently regress to plain text without it:

| language | adds |
| --- | --- |
| Dockerfile | `/^Dockerfile(\..+)?$/i` (registry: exact `Dockerfile` only) |
| Shell | `zsh`, `fish`; `/^justfile$/i` (registry: `sh`/`ksh`/`bash` + `PKGBUILD`) |
| Properties files | `env`, `conf`; `/^\.env(\..+)?$/i` |
| HTML | `astro`, `svelte`, `ejs`, `mustache`, `twig`, `njk` (`hbs`/`handlebars` are already upstream) |
| Markdown | `mdx` |
| Python | `pyi` |
| Ruby | `rake` |
| Groovy | `gvy` |

**Visible change:** the registry splits JSX/TSX out of JavaScript/TypeScript,
so a `.tsx` file's breadcrumb now reads "TSX". Same grammar, different label.
Accepted, and arguably more correct.

## Accepted cost

Measured by wiring the registry into `EditorPane` behind a live call site and
diffing `npm run build` against the same build without it. (A tree-shaken probe
measures nothing — the first attempt reported an unchanged bundle because
rolldown dropped the reference. Re-measure that way if these numbers are ever
rechecked.)

| | before | after |
| --- | --- | --- |
| main `index` chunk | 2300K | **2300K** (unchanged) |
| editor chunk (first file opened) | 604K | **644K** (+40K) |
| total `dist/` | 7208K | **8032K** (+824K, 94 lazy chunks) |
| new npm deps | — | 1 direct (`language-data`), 8 transitive Lezer grammars |

App start pays nothing, the first opened file pays 40K for the index, and the
`.app` carries ~0.8MB of grammars that are only ever *loaded* for a language
the user actually opens.

**Hold app start at zero.** The registry may only be reachable from the lazily
loaded editor/diff panes. Pin it with a source-level import-graph test, the way
`cspGuard.test.ts` pins the CSP.

Two consequences the first draft missed, both of which are what that test would
have caught:

- **`SyntaxPalette` is in the main chunk** (`Dialogs.tsx` → `App.tsx:25`), so it
  cannot statically import the registry. It `import()`s the list when it opens.
  By then the editor pane is loaded, so the module is already cached and the
  list is there within a microtask.
- **`effectiveLanguageId` is in the main chunk too** (breadcrumb, command
  palette), so it cannot do path matching any more. Path resolution moves into
  the pane, which writes its answer to the existing `tab.syntaxAuto` slot.
  Precedence in the main chunk collapses to `syntax ?? syntaxAuto ?? PLAIN_TEXT`
  while the pane keeps all three levels internally. `syntaxAuto` now means
  "whatever was determined automatically" (path, else sniff), which is what its
  name always claimed.

## The work

**1. Async loading.** `langForId` returns an `Extension` synchronously today;
the registry returns a promise. Both panes already mount from inside an async
IIFE that awaits the file read, so the grammar load joins that await rather
than forcing a mount-then-reconfigure:

```ts
const [content, lang] = await Promise.all([read(), resolveLanguageForPath(path)]);
```

Path-less buffers (scratchpads) fall through to the sniffer and take a second
await. Highlighting is therefore present on first paint, no unhighlighted flash.

The live "Set syntax" reconfigure is the one genuinely racy path, and it needs a
**generation guard**: a counter bumped on mount, path change, and every syntax
change; captured before the await; the result dropped if it no longer matches.
`alive` is not enough on its own — it does not catch a slow mount-time load
landing on top of a fast manual pick. It gets its own test.

**2. Ids become registry names.** Use the registry's `name` ("TypeScript",
"Makefile"); `languageLabel()` keeps rendering an unknown id verbatim so a
stored name that later disappears degrades to plain text instead of blank.
`lib/detectSyntax.ts` returns those names too (note "Properties files", lower-
case f, is the registry's actual spelling).

`EditTab.syntax` is session-only, but **`ScratchTab.syntax` is persisted** in
the scratch index and shipped in 0029565, so a pad set to `"json"` on the
current build would come back plain. A frozen `LEGACY_IDS` map (~25 old ids →
names) translates on read. It is a closed migration list, not a catalog that
grows; indexed in `docs/tech-debt.md` for deletion later.

**3. `lib/languages.ts` gets thin.** It keeps `PLAIN_TEXT`, `MARKDOWN`,
`effectiveLanguageId`'s precedence, `languageLabel`, `LEGACY_IDS`, and the note
pointing the LSP work at it as the one place a `languageId` is decided. The
`LANGUAGES` array and `languageIdForPath` are deleted. `isKnownLanguage` moves
to `lib/languageExts.ts`, since "known" now means "in the registry".

**4. The picker sources from the registry**, lazily (above), mapping
`LanguageDescription[]` to rows (name + `alias` for the fuzzy search), Plain
Text pinned first.

**5. `lib/languageExts.ts` loses its switch**, keeping the three custom
descriptions, the overlay, `matchLanguage`, and the loaders.

## Testing

- **Unit:** every filename case the current suite pins must survive — `Makefile`,
  `GNUmakefile`, `Makefile.local`, `common.mk`, `Dockerfile`, `Dockerfile.dev`,
  `justfile`, `.env.production`, `gradle.properties`, `build.gradle` (Groovy) vs
  `build.gradle.kts` (Kotlin), `Package.swift`, `README.MD`. Plus the registry
  languages nobody hand-added (`.php`, `.lua`, `.zig`… ), the legacy-id
  translation, and the main-chunk import-graph invariant.
- **Async race:** resolve a grammar, change the syntax mid-flight, assert the
  stale grammar never lands.
- **e2e:** the existing `editor.e2e.ts` syntax cases stay as they are — they
  assert *rendered tokens*, so they prove the async path really reaches
  CodeMirror. Add one case for a language nobody hand-added (PHP): open the
  file, get highlighting, with zero termic-side registration. That is the whole
  feature in one assertion.

## Out of scope

Highlighting inside terminal output; anything LSP (`docs/plans/lsp.md` owns
that, and should read its `languageId` from the same place); shipping grammars
the registry does not include.
