// ⌘-click, the way JetBrains does it (GH #174).
//
// One gesture, two outcomes, and which one you get depends on where you are:
//
//  - ⌘-click a USAGE jumps to the definition.
//  - ⌘-click the DEFINITION lists the usages, because "go to definition" from
//    the definition is a no-op, and what you actually wanted at that moment is
//    "who calls this".
//
// That second half is the part people miss when they move off IntelliJ, and it
// costs one extra comparison: ask for the definition, and if the answer is the
// place you clicked, ask for references instead.
//
// The keyboard route (F12 / Shift-F12) stays as it was; this is the same two
// commands under a pointer.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";
import { setUsages, type UsageRow } from "./usagesPopup";
import { uriToPath, pathToUri, readAnyFile } from "./workspace";
import { currentPoint, navigateTo, pointFor, taskForPath } from "./navigate";
import { usageLabels } from "./usageLabels";
import { isDeclarationOnly, sourceCandidates, findSymbolLine } from "./declarationSource";

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
type LspLocation = { uri: string; range: LspRange };
type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | Array<{ targetUri: string; targetSelectionRange: LspRange; targetRange: LspRange }>
  | null;

/** Servers answer with any of three shapes; the spec allows all of them. */
function firstLocation(result: DefinitionResult): LspLocation | null {
  if (!result) return null;
  const one = Array.isArray(result) ? result[0] : result;
  if (!one) return null;
  if ("targetUri" in one) {
    return { uri: one.targetUri, range: one.targetSelectionRange ?? one.targetRange };
  }
  return one;
}

/** Is `pos` inside this location, in this file? That is the test for "you are
 *  already standing on the definition". */
function containsCursor(view: EditorView, uri: string, range: LspRange, pos: number): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin || plugin.uri !== uri) return false;
  const doc = view.state.doc;
  const at = (p: { line: number; character: number }) => {
    const line = doc.line(Math.max(1, Math.min(p.line + 1, doc.lines)));
    return Math.min(line.from + p.character, line.to);
  };
  return pos >= at(range.start) && pos <= at(range.end);
}

/**
 * Go to the definition of the symbol at `pos`, or list its usages when `pos`
 * IS the definition.
 */
export async function goToDefinitionOrUsages(view: EditorView, pos: number): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const client = plugin.client;
  // Move the cursor first: both commands read the selection, and it is also
  // what the user expects a click to have done regardless of the outcome.
  view.dispatch({ selection: { anchor: pos } });
  // A server that failed to spawn rejects here; a ⌘-click must not become an
  // unhandled rejection, and the caller has nothing useful to do with it.
  try { await client.initializing; } catch { return; }
  if (!client.serverCapabilities?.definitionProvider) return;
  client.sync();

  let result: DefinitionResult = null;
  try {
    result = await client.request<unknown, DefinitionResult>("textDocument/definition", {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
    });
  } catch {
    return;   // a server that is still indexing answers nothing; not an error
  }
  const target = firstLocation(result);

  // Nothing, or the definition IS here: the useful answer is who uses it.
  if (!target || containsCursor(view, target.uri, target.range, pos)) {
    await showUsages(view, pos);
    return;
  }

  await landOn(view, target, pos);
}

/** Take the reader to a location the server named, improving it first. */
async function landOn(view: EditorView, target: LspLocation, clickedAt: number): Promise<void> {
  let uri = target.uri;
  let line = target.range.start.line + 1;
  let col = target.range.start.character + 1;

  // A declaration file is the right answer to "what type is this" and the
  // wrong one to "show me this code". Trade it for the implementation when we
  // can find it; keep it when we cannot, since a stub beats nothing.
  const better = await implementationFor(view, uri, clickedAt);
  if (better) {
    uri = better.uri;
    line = better.line;
    col = 1;
  }

  const abs = uriToPath(uri);
  const task = abs ? taskForPath(abs) : null;
  if (!abs || !task) return;
  // Through the one navigation path, so Back returns to the call site.
  await navigateTo(view, pointFor(task.id, task.path, abs, line, col), currentPoint(view));
}

/**
 * Swap a declaration file for the code it declares.
 *
 * Only when the server sent us to one: `.pyi`, `.d.ts`. Everything else (Rust,
 * Go, ordinary Python and TypeScript files) returns null immediately and the
 * server's answer stands.
 */
async function implementationFor(
  view: EditorView,
  declUri: string,
  clickedAt: number,
): Promise<{ uri: string; line: number } | null> {
  const declPath = uriToPath(declUri);
  if (!declPath || !isDeclarationOnly(declPath)) return null;
  // The word under the cursor names what we are looking for in the source.
  const word = view.state.wordAt(clickedAt);
  const symbol = word ? view.state.sliceDoc(word.from, word.to) : "";
  if (!symbol) return null;

  for (const candidate of sourceCandidates(declPath)) {
    const text = await readAnyFile(candidate);
    if (text == null) continue;
    const line = findSymbolLine(text, symbol, declPath);
    // A file that exists but does not mention the symbol is the wrong file:
    // following it would land the reader somewhere unrelated, which is worse
    // than the stub they at least asked about.
    if (line == null) continue;
    return { uri: pathToUri(candidate), line };
  }
  return null;
}

/**
 * The gesture. Mousedown rather than click, so the editor never gets to place
 * a selection and start a drag first, which is what makes a modified click
 * feel like a button instead of a text selection.
 */
export const modClickNavigation: Extension = [
  // Marks this editor as one where a modified click navigates, which is what
  // the cursor affordance keys off (index.css). An editor with no server keeps
  // a text caret, so nothing pretends to be clickable.
  EditorView.editorAttributes.of({ class: "cm-lsp-navigable" }),
  EditorView.domEventHandlers({
  mousedown(event, view) {
    // ⌘ on macOS, Ctrl elsewhere. `metaKey` is the one the rest of the app
    // treats as the modifier (see the `termic-mod-held` class in main.tsx).
    const mod = event.metaKey || (navigator.platform.startsWith("Mac") ? false : event.ctrlKey);
    if (!mod || event.button !== 0 || event.altKey || event.shiftKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    event.preventDefault();
    void goToDefinitionOrUsages(view, pos);
    return true;
  },
  }),
];

/**
 * Go to the implementation(s), or the type's declaration.
 *
 * IntelliJ's ⌥⌘B and ⌃⇧B. Both are the same request shape as definition, so
 * they share its landing logic — including the declaration-to-source hop,
 * because `implementation` on a stubbed package lands in the stub too.
 */
export async function goToRelated(
  view: EditorView,
  pos: number,
  method: "implementation" | "typeDefinition",
): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const client = plugin.client;
  // A server that failed to spawn rejects here; a ⌘-click must not become an
  // unhandled rejection, and the caller has nothing useful to do with it.
  try { await client.initializing; } catch { return; }
  const capability = method === "implementation" ? "implementationProvider" : "typeDefinitionProvider";
  if (!client.serverCapabilities?.[capability]) return;
  client.sync();
  let result: DefinitionResult = null;
  try {
    result = await client.request<unknown, DefinitionResult>(`textDocument/${method}`, {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
    });
  } catch {
    return;
  }
  const target = firstLocation(result);
  if (!target) return;
  await landOn(view, target, pos);
}

/**
 * Ask for the references and float them at the symbol.
 *
 * Not the client's own `findReferences`: that renders a panel docked under the
 * editor, and it silently DROPS every location in a file nothing has open,
 * which the first time you look at a symbol is most of them. This resolves
 * each location through the workspace (which reads from disk, see
 * `requestFile`) so the list is the whole answer.
 */
export async function showUsages(view: EditorView, pos: number): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const client = plugin.client;
  // A server that failed to spawn rejects here; a ⌘-click must not become an
  // unhandled rejection, and the caller has nothing useful to do with it.
  try { await client.initializing; } catch { return; }
  if (!client.serverCapabilities?.referencesProvider) return;
  client.sync();

  // The word under the cursor, for the header and for the mark that keeps the
  // symbol tied to the list while it is open. Read BEFORE the request, because
  // an empty answer still has to name what was asked about.
  const wordRange = view.state.wordAt(pos);
  const symbol = wordRange ? view.state.sliceDoc(wordRange.from, wordRange.to) : "";
  const symbolOffset = wordRange ? pos - wordRange.from : 0;
  /** Say "No usages" rather than nothing. Silence is indistinguishable from a
   *  broken feature, and "nobody calls this" is a fact worth having about the
   *  function you were about to change. */
  const sayNone = () => {
    view.dispatch({ effects: setUsages.of({ pos, symbol, symbolOffset, rows: [] }) });
  };

  let locations: LspLocation[] | null = null;
  try {
    locations = await client.request<unknown, LspLocation[] | null>("textDocument/references", {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
      context: { includeDeclaration: true },
    });
  } catch {
    return;
  }
  if (!locations?.length) { sayNone(); return; }

  // Servers repeat themselves: a reference reported once per open document and
  // once from the index arrives twice, and the popup listed both, so four
  // usages read as eight with the same line numbers twice over. Deduped on
  // what makes a usage the same usage, before anything else counts them.
  const seenLoc = new Set<string>();
  const unique = locations.filter((l) => {
    const key = `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
    if (seenLoc.has(key)) return false;
    seenLoc.add(key);
    return true;
  });

  // A name per row: bare where it is unambiguous, a path only where two files
  // share a basename (`lib/lsp/usageLabels.ts`). Relative to each file's own
  // checkout, since a usage can land outside this one.
  const paths = unique.map(l => uriToPath(l.uri) ?? l.uri);
  const labels = usageLabels(paths.map(p => ({ path: p, root: taskForPath(p)?.path ?? null })));

  const rows: UsageRow[] = [];
  for (const [i, loc] of unique.entries()) {
    const abs = paths[i];
    const file = await client.workspace.requestFile(loc.uri);
    if (!file) continue;
    const doc = file.getView()?.state.doc ?? file.doc;
    const lineNo = Math.max(1, Math.min(loc.range.start.line + 1, doc.lines));
    const line = doc.line(lineNo);
    // Leading indentation is never the interesting part of a usage row.
    const trimmed = line.text.replace(/^\s+/, "");
    const shift = line.text.length - trimmed.length;
    rows.push({
      uri: loc.uri,
      path: abs,
      file: labels[i],
      line: lineNo,
      text: trimmed.slice(0, 200),
      from: Math.max(0, loc.range.start.character - shift),
      to: Math.max(0, loc.range.end.character - shift),
    });
  }
  if (!rows.length) return;
  view.dispatch({ effects: setUsages.of({ pos, symbol, symbolOffset, rows }) });
}

