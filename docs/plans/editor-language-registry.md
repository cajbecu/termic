# Language support from the filename, with no per-language edits

**Approved.** Cost accepted (measured below). This replaces the hand-maintained
language catalog with CodeMirror's published registry, so opening a file of
*any* language it knows lights up without anyone editing termic first.

Today adding a language is two edits — an entry in `lib/languages.ts` and a
`case` in `lib/languageExts.ts`. That is how Swift and Groovy/Gradle went in.
After this, neither file has a list to add to.

## What "automatic" means, precisely

Matching is **by filename**, which is both halves of what that implies:

- **Extension** — `.swift`, `.gradle`, `.php`, `.zig`.
- **Whole-filename patterns** — `Dockerfile`, `Makefile`, `justfile`,
  `.env.production`. `LanguageDescription.matchFilename()` handles both, so the
  special-case list in `languageIdForPath` goes away with the catalog.

Two things stay in front of it, unchanged, and the precedence order in
`effectiveLanguageId` does not move:

1. **A manual "Set syntax" pick** still wins over everything.
2. **The content sniffer** (`lib/detectSyntax.ts`) still answers when the
   filename says nothing — an extension-less file, and every scratchpad
   (GH #244), which by definition has no filename at all.

## The registry

`@codemirror/language-data`: ~150 `LanguageDescription`s, each carrying its
extensions, filename patterns, aliases, and a lazy loader.

```ts
const desc = LanguageDescription.matchFilename(languages, "build.gradle");
const support = desc && await desc.load();   // dynamic import, code-split
```

**Our two extras are registered alongside it**, not replaced by it: nothing
upstream has a Makefile grammar (`lib/makeMode.ts`), and the shipped protobuf
mode predates proto3 (`lib/protoMode.ts`). The end state is "the registry plus
our two", expressed as `LanguageDescription.of(...)` entries prepended to the
list so ours win on a tie.

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
| new npm deps | — | 9 (`language-data` + 8 Lezer grammars we lack) |

App start pays nothing, the first opened file pays 40K for the index, and the
`.app` carries ~0.8MB of grammars that are only ever *loaded* for a language
the user actually opens.

**Hold app start at zero.** The registry may only be reachable from the lazily
loaded editor/diff panes. `lib/languages.ts` is imported by the command palette
and the breadcrumb, i.e. the main chunk, so it must not import
`@codemirror/language-data` — pin that with a source-level test, the way
`cspGuard.test.ts` pins the CSP.

## The work

**1. Async loading.** The awkward part. `langForId` returns an `Extension`
synchronously today and the editor mounts with it; the registry returns a
promise. So the editor mounts with no grammar and reconfigures its language
compartment when the load resolves. The compartment is already the live-switch
mechanism (Set-syntax uses it), so the machinery exists.

It needs a **cancellation guard**: bump a generation counter per mount/path
change, capture it before the await, and drop the result if it no longer
matches. A fast tab switch must never land a resolved grammar in a view that
has since been rebuilt — that is the async-mount race the no-StrictMode rule
exists for, and it gets its own test.

**2. Ids become registry names.** `EditTab.syntax` is session-only today, so
there is nothing to migrate — but fix the contract now, because the scratchpad
plan persists a pick in its index. Use the registry's `name` ("TypeScript",
"Makefile"); `languageLabel()` keeps rendering an unknown id verbatim so a
stored name that later disappears degrades to plain text instead of blank.
`lib/detectSyntax.ts` returns those names too.

**3. `lib/languages.ts` gets thin.** It keeps `PLAIN_TEXT`,
`effectiveLanguageId`'s precedence, `languageLabel`, and the note pointing the
LSP work at it as the one place a `languageId` is decided. The `LANGUAGES`
array and `languageIdForPath`'s rules are deleted, not ported.

**4. The picker sources from the registry.** `SyntaxPalette` maps
`LanguageDescription[]` to rows (name + `alias` for the fuzzy search), keeping
Plain Text pinned first. That is a straight simplification.

**5. `lib/languageExts.ts` loses its switch**, keeping only the two custom
descriptions and the registry lookup.

## Testing

- **Unit:** the filename cases the current suite already pins must survive the
  swap — `Makefile`, `Dockerfile.dev`, `justfile`, `.env.production`,
  `build.gradle` (Groovy) vs `build.gradle.kts` (Kotlin), `README.MD`. Plus the
  new invariant: nothing in the main chunk's import graph pulls in
  `language-data`.
- **Async race:** mount, switch path before the load resolves, assert the stale
  grammar never lands.
- **e2e:** the existing `editor.e2e.ts` syntax cases stay as they are — they
  assert *rendered tokens*, so they prove the async path really reaches
  CodeMirror. Add one case for a language nobody hand-added (PHP or Lua): open
  the file, get highlighting, with zero termic-side registration. That is the
  whole feature in one assertion.

## Out of scope

Highlighting inside terminal output; anything LSP (`docs/ideas/lsp.md` owns
that, and should read its `languageId` from the same place); shipping grammars
the registry does not include.
