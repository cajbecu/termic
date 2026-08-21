// The catalog of syntaxes the editor knows about: one entry per language, the
// extensions / filenames that pick it automatically, and the label the "Set
// syntax" picker shows.
//
// Deliberately free of CodeMirror imports. The picker, the breadcrumb and the
// content sniffer need LABELS and IDS, not grammars, and importing
// `@codemirror/lang-*` here would drag every grammar into the main bundle —
// today they are only reachable through the lazily-loaded editor / diff panes.
// The grammars live in `lib/languageExts.ts`, which only those panes import.

export interface LanguageDef {
  id: string;
  /** Shown in the picker and on the breadcrumb button. */
  label: string;
  /** Lower-case extensions (no dot) that select this language. */
  exts?: string[];
  /** Whole-basename patterns, tried BEFORE extensions — `Dockerfile.dev` is a
   *  Dockerfile, not a `.dev` file. */
  filenames?: RegExp[];
  /** Extra fuzzy-search terms for the picker. Never displayed. */
  keywords?: string;
}

// A note for docs/ideas/lsp.md, which needs a `(taskId, path) -> { version,
// languageId }` registry: THIS is the place to read the language from, and
// `effectiveLanguageId` already folds in the user's manual override. The ids
// below are termic's own, chosen to match the LSP spec's `languageId` strings
// where that was free, but they are NOT identical to it (`shell` vs
// `shellscript`, `properties` vs `ini`, one `cpp` entry covering C and C++
// because one Lezer grammar covers both). An LSP host wants a small explicit
// termic-id → LSP-id table, not an assumption that these already are one.

/** The "no grammar at all" entry. A real id (not `null`) so picking it is a
 *  deliberate choice the tab can remember, distinct from "nothing matched". */
export const PLAIN_TEXT = "text";

/** Every language the editor can highlight. Order matters only for the
 *  filename pass (first match wins); the picker sorts by label itself. */
export const LANGUAGES: LanguageDef[] = [
  { id: PLAIN_TEXT, label: "Plain Text", keywords: "none off plain raw txt" },
  { id: "javascript", label: "JavaScript", exts: ["js", "jsx", "mjs", "cjs"], keywords: "node es esm react" },
  { id: "typescript", label: "TypeScript", exts: ["ts", "tsx", "mts", "cts"], keywords: "tsx react types" },
  { id: "python", label: "Python", exts: ["py", "pyi"] },
  { id: "rust", label: "Rust", exts: ["rs"], keywords: "cargo" },
  { id: "go", label: "Go", exts: ["go"], keywords: "golang" },
  { id: "java", label: "Java / Kotlin", exts: ["java", "kt", "kts"], keywords: "kotlin jvm gradle" },
  { id: "swift", label: "Swift", exts: ["swift"], keywords: "ios macos xcode apple" },
  // Gradle build scripts are Groovy (`build.gradle`); the Kotlin DSL variant
  // ends in `.kts` and lands on the Java/Kotlin grammar above.
  { id: "groovy", label: "Groovy / Gradle", exts: ["groovy", "gradle", "gvy"], keywords: "gradle build jvm" },
  { id: "cpp", label: "C / C++", exts: ["c", "cc", "cpp", "cxx", "h", "hpp", "hh"], keywords: "c++ header" },
  { id: "elixir", label: "Elixir", exts: ["ex", "exs"] },
  { id: "ruby", label: "Ruby", exts: ["rb", "rake"], keywords: "rails gem" },
  { id: "shell", label: "Shell", exts: ["sh", "bash", "zsh", "fish"], filenames: [/^justfile$/i], keywords: "bash sh zsh script" },
  { id: "makefile", label: "Makefile", exts: ["mk", "mak"], filenames: [/^(gnu)?makefile(\..+)?$/i], keywords: "make target recipe build" },
  { id: "dockerfile", label: "Dockerfile", filenames: [/^dockerfile/i], keywords: "container image docker" },
  { id: "json", label: "JSON", exts: ["json"] },
  { id: "yaml", label: "YAML", exts: ["yaml", "yml"], keywords: "config" },
  { id: "toml", label: "TOML", exts: ["toml"], keywords: "cargo config" },
  { id: "xml", label: "XML", exts: ["xml", "svg"] },
  { id: "html", label: "HTML", exts: ["html", "htm", "vue", "svelte", "astro", "hbs", "handlebars", "ejs", "mustache", "twig", "liquid", "njk"], keywords: "template markup jsx vue svelte" },
  { id: "css", label: "CSS", exts: ["css"], keywords: "style" },
  { id: "markdown", label: "Markdown", exts: ["md", "markdown", "mdx"], keywords: "docs readme" },
  { id: "sql", label: "SQL", exts: ["sql"], keywords: "query database" },
  { id: "protobuf", label: "Protocol Buffers", exts: ["proto"], keywords: "proto3 grpc" },
  { id: "properties", label: "INI / Properties", exts: ["properties", "conf", "ini", "env"], filenames: [/^\.env(\..+)?$/i], keywords: "config dotenv settings" },
];

const BY_ID = new Map(LANGUAGES.map(l => [l.id, l]));

/** Human label for an id, falling back to the id itself for anything the
 *  catalog has since dropped (a persisted override from an older build). */
export function languageLabel(id: string | null | undefined): string {
  if (!id) return "Plain Text";
  return BY_ID.get(id)?.label ?? id;
}

export function isKnownLanguage(id: string): boolean {
  return BY_ID.has(id);
}

/** The language a path selects on its own, or null when nothing matches.
 *  Filenames are tried before extensions (`Dockerfile.dev`, `Makefile.local`). */
export function languageIdForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split("/").pop() || path;
  for (const lang of LANGUAGES) {
    if (lang.filenames?.some(re => re.test(base))) return lang.id;
  }
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  if (!ext) return null;
  for (const lang of LANGUAGES) {
    if (lang.exts?.includes(ext)) return lang.id;
  }
  return null;
}

/** What a tab is ACTUALLY highlighted as, in precedence order:
 *  a manual pick beats the path, which beats the content sniff. The sniff only
 *  ever fills in for a path no rule claimed (see lib/detectSyntax). */
export function effectiveLanguageId(
  tab: { path?: string; syntax?: string; syntaxAuto?: string } | null | undefined,
): string {
  if (!tab) return PLAIN_TEXT;
  if (tab.syntax) return tab.syntax;
  return languageIdForPath(tab.path) ?? tab.syntaxAuto ?? PLAIN_TEXT;
}
