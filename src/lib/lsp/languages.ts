// Which language a buffer is, in the LSP's vocabulary rather than ours.
//
// `effectiveLanguageId` (lib/languages.ts) is the ONE place a buffer's
// language is decided, and it folds in the user's manual Set-syntax pick. Its
// ids are CodeMirror's registry NAMES ("TypeScript", "Properties files"),
// which are not the LSP spec's ids ("typescript", "ini"), so the translation
// lives here rather than being guessed at each call site.
//
// The map is deliberately small: it covers the languages a server can be
// resolved for (see `lsp_resolve_server` in lib.rs) plus the ones whose names
// differ enough that a lowercase fallback would be wrong. Everything else
// lowercases, which is right far more often than not.

/** CodeMirror registry name → LSP `languageId`. */
const LSP_ID_BY_NAME: Record<string, string> = {
  "TypeScript": "typescript",
  "TSX": "typescriptreact",
  "JavaScript": "javascript",
  "JSX": "javascriptreact",
  "Python": "python",
  "Rust": "rust",
  "Go": "go",
  "C": "c",
  "C++": "cpp",
  "C#": "csharp",
  "Objective-C": "objective-c",
  "Objective-C++": "objective-cpp",
  "Swift": "swift",
  "Ruby": "ruby",
  "Shell": "shellscript",
  "Properties files": "ini",
  "Markdown": "markdown",
  "HTML": "html",
  "CSS": "css",
  "JSON": "json",
  "YAML": "yaml",
};

/** The server family that answers for a language id, or null if none does.
 *  One server serves several `languageId`s: TSX and JS all go to TypeScript,
 *  which is why this is not the identity function. */
const SERVER_BY_LSP_ID: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "typescript",
  javascriptreact: "typescript",
  python: "python",
  rust: "rust",
  go: "go",
  // One server for the whole C family, which is what clangd is.
  c: "cpp",
  cpp: "cpp",
  "objective-c": "cpp",
  "objective-cpp": "cpp",
  swift: "swift",
  ruby: "ruby",
};

/** Every server id, which is also every language code intelligence can serve.
 *  Derived, so a row above is the only edit a new language needs: this was a
 *  second hand-written list in the Search Everywhere dialog, and a list that
 *  has to be kept in step with another list eventually is not. */
export const SERVERS: readonly string[] = [...new Set(Object.values(SERVER_BY_LSP_ID))];

/** The LSP `languageId` for a CodeMirror registry name. */
export function lspLanguageId(registryName: string | null | undefined): string | null {
  if (!registryName) return null;
  return LSP_ID_BY_NAME[registryName] ?? registryName.toLowerCase();
}

/** Which server would serve this buffer, by the name the Rust host knows it
 *  by. Null means "no navigation for this language", which the UI must show
 *  as an absence rather than as a broken toggle. */
export function lspServerFor(registryName: string | null | undefined): string | null {
  const id = lspLanguageId(registryName);
  return id ? SERVER_BY_LSP_ID[id] ?? null : null;
}

/**
 * The LANGUAGE a server id serves, as a person writes it.
 *
 * Server ids are lowercase internal keys ("python", "typescript") and were
 * reaching the UI verbatim, so a row read "Turn on code intelligence for
 * python". The id is not a name.
 */
const LANGUAGE_NAME: Record<string, string> = {
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  cpp: "C and C++",
  swift: "Swift",
  ruby: "Ruby",
};

export function languageName(server: string): string {
  return LANGUAGE_NAME[server] ?? server;
}
