// What language a buffer is highlighted as: the precedence rule, the labels,
// and nothing else. There is no catalog here any more — the set of languages
// termic knows is CodeMirror's published registry (`@codemirror/language-data`,
// ~150 of them), composed with our own additions in `lib/languageExts.ts`.
//
// A language id IS the registry's `name`: "TypeScript", "Makefile",
// "Properties files". Not lower-case slugs, not the LSP spec's ids.
//
// Deliberately free of CodeMirror imports, and `lib/mainChunkGuard.test.ts`
// pins that. This module is reachable from the command palette and the
// breadcrumb, i.e. the MAIN chunk; `@codemirror/language-data` pulls ~800K of
// lazily-loaded grammars behind it and must stay reachable only from the
// lazily-loaded editor / diff panes.

// A note for docs/plans/lsp.md, which needs a `(taskId, path) -> { version,
// languageId }` registry: THIS is the place to read the language from, and
// `effectiveLanguageId` already folds in the user's manual override. The names
// are CodeMirror's, and they are NOT the LSP spec's `languageId` strings
// ("Shell" vs `shellscript`, "Properties files" vs `ini`). An LSP host wants a
// small explicit name → LSP-id table, not an assumption that these are one.

/** The "no grammar at all" entry. A real id (not `null`) so picking it is a
 *  deliberate choice the tab can remember, distinct from "nothing matched".
 *  Not a registry name — nothing upstream owns "plain text". */
export const PLAIN_TEXT = "Plain Text";

/** The registry's spelling, used by the tab chrome to decide a markdown
 *  buffer gets the preview shell. A bare string literal at the call site is
 *  one typo away from silently never matching. */
export const MARKDOWN = "Markdown";

/** Ids termic used before the registry swap, mapped to the registry name that
 *  replaces them.
 *
 *  Only `ScratchTab.syntax` ever outlives a session (it is written to the
 *  scratch index, GH #244), so this exists for exactly one case: a pad whose
 *  syntax was picked on a build that shipped between 0029565 and this one.
 *  Everything else is re-derived from the path on open.
 *
 *  A CLOSED list. Nothing gets added to it — a new language needs no entry
 *  anywhere, which is the point of the swap. Removable once no pad in the
 *  wild can still carry an old id; indexed in docs/tech-debt.md. */
const LEGACY_IDS: Record<string, string> = {
  text: PLAIN_TEXT,
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  swift: "Swift",
  groovy: "Groovy",
  cpp: "C++",
  elixir: "Elixir",
  ruby: "Ruby",
  shell: "Shell",
  makefile: "Makefile",
  dockerfile: "Dockerfile",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  markdown: MARKDOWN,
  sql: "SQL",
  protobuf: "ProtoBuf",
  properties: "Properties files",
};

/** Translate a stored id, leaving anything already a registry name alone.
 *  Registry names are capitalised and the legacy ids were not, so the two
 *  spaces cannot collide. */
export function normalizeLanguageId(id: string): string {
  return LEGACY_IDS[id] ?? id;
}

/** Human label for an id. Registry names ARE the label, so this is mostly
 *  identity — its job is the fallbacks: a legacy id from an older build, and
 *  a name the registry has since dropped, which renders verbatim rather than
 *  blank. */
export function languageLabel(id: string | null | undefined): string {
  if (!id) return PLAIN_TEXT;
  return normalizeLanguageId(id);
}

/** What a tab is ACTUALLY highlighted as, in precedence order: a manual pick
 *  beats whatever was worked out automatically.
 *
 *  Only TWO levels here, unlike the three the docs describe, because the third
 *  cannot live in the main chunk: resolving a PATH to a language now needs the
 *  registry. The pane does that work (path first, content sniff second, see
 *  lib/languageExts + lib/detectSyntax) and writes its answer to `syntaxAuto`,
 *  so the breadcrumb and the picker read one settled value instead of
 *  re-deriving it. Until the pane has answered, a freshly opened tab reads as
 *  Plain Text for a frame. */
export function effectiveLanguageId(
  tab: { path?: string; syntax?: string; syntaxAuto?: string } | null | undefined,
): string {
  if (!tab) return PLAIN_TEXT;
  const id = tab.syntax || tab.syntaxAuto;
  return id ? normalizeLanguageId(id) : PLAIN_TEXT;
}
