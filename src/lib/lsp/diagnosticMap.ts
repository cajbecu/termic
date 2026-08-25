// LSP diagnostic → CodeMirror diagnostic, for both delivery models.
//
// Push (`textDocument/publishDiagnostics`, in `workspace.ts`) and pull
// (`textDocument/diagnostic`, in `pullDiagnostics.ts`) each build their own,
// and the two had drifted: the pull path attributed a diagnostic to the server
// that raised it and the push path did not, so whether an underline said where
// it came from depended on a protocol detail no reader can see.

/** LSP `DiagnosticSeverity` → CodeMirror's four levels. Anything a server
 *  omits or invents is an error, which is the safe way to be wrong: an
 *  unreported error is worse than an over-reported one. */
export function severityOf(severity: number | undefined): "error" | "warning" | "info" | "hint" {
  return severity === 2 ? "warning" : severity === 3 ? "info" : severity === 4 ? "hint" : "error";
}

/**
 * What the tooltip prints under the message: "zuban [assignment]".
 *
 * The CODE is the half that does something. A type checker's message says what
 * it thinks is wrong; the code is the handle you need to act on it, and for a
 * mypy-compatible checker it is literally the argument: `# type: ignore[…]` on
 * the line, `disable_error_code = […]` in the project's mypy config. Dropping
 * it (which both mappers did) left the reader a paragraph of prose and no way
 * to look the rule up or turn it off.
 *
 * CodeMirror's `Diagnostic` has no code field, so it rides along in `source`,
 * which is the line the lint tooltip already renders in its own dim style.
 */
export function attribution(
  source: string | undefined,
  code: string | number | undefined,
): string | undefined {
  const c = code === undefined || code === null || code === "" ? "" : String(code);
  // Brackets even with no server name: bare "assignment" under a message
  // reads as a stray word, where "[assignment]" reads as a rule id.
  if (!source) return c ? `[${c}]` : undefined;
  return c ? `${source} [${c}]` : source;
}
