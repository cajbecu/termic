// Keep a queued review comment pinned to the code it was made on, not to the
// line number it happened to sit at.
//
// A comment is stored as a 1-based line range plus the quoted source (see
// store/reviewComments.ts). That is the right shape to SEND — an agent reads
// "src/foo.ts:12-40" and a snippet — but line numbers are the wrong thing to
// HOLD while a comment waits in the queue: in an editable buffer, typing three
// lines above a comment silently moves the code it points at, and the batch
// then tells the agent to look in the wrong place.
//
// So while an editor is open, the comment's real selection lives on as a pair
// of document offsets that get mapped through every change the doc takes. The
// stored lines + quote are re-derived from that anchor. These helpers are the
// whole of that arithmetic, kept free of CodeMirror view/state plumbing so they
// can be tested against plain documents.

import { ChangeDesc, Text } from "@codemirror/state";

/** A selection held across edits, as document offsets. */
export interface Anchor { from: number; to: number }

/** Offsets covering whole lines `startLine`..`endLine` (1-based, inclusive),
 *  clamped to the doc. `from` is the first line's start, `to` the last line's
 *  end — a comment targets whole lines, the way the tooltip captures them. */
export function anchorForLines(doc: Text, startLine: number, endLine: number): Anchor {
  const s = Math.max(1, Math.min(Math.floor(startLine), doc.lines));
  const e = Math.max(s, Math.min(Math.floor(endLine), doc.lines));
  return { from: doc.line(s).from, to: doc.line(e).to };
}

/** The 1-based line range an anchor now covers. */
export function linesForAnchor(doc: Text, a: Anchor): { startLine: number; endLine: number } {
  const from = Math.max(0, Math.min(a.from, doc.length));
  const to = Math.max(from, Math.min(a.to, doc.length));
  return { startLine: doc.lineAt(from).number, endLine: doc.lineAt(to).number };
}

/**
 * Carry an anchor across a document change.
 *
 * The association pair is the whole subtlety. `from` maps with **1** and `to`
 * with **-1**, i.e. the range does NOT extend at its edges: text inserted at
 * the exact start of the first commented line is text typed ABOVE the comment,
 * so the comment slides down instead of swallowing it, and text appended right
 * after the last commented line stays outside it. Get this backwards (the
 * intuitive -1/1 pair, which is right for a text SELECTION being extended) and
 * a comment on line 1 grows to cover every line inserted above it, which is
 * exactly the bug this module exists to prevent.
 *
 * Edits strictly inside the range still grow it, and whole-line expansion in
 * `quoteForAnchor` means edge-adjacent typing still shows up in the quote. A
 * change that deletes the range collapses it to a single position (callers
 * decide what an emptied comment means).
 */
export function mapAnchor(a: Anchor, changes: ChangeDesc): Anchor {
  const from = changes.mapPos(a.from, 1);
  const to = changes.mapPos(a.to, -1);
  return { from, to: Math.max(from, to) };
}

/** The source text an anchor now covers, expanded to whole lines so the quote
 *  reads like the file does. Empty when the range was deleted away. */
export function quoteForAnchor(doc: Text, a: Anchor): string {
  const { startLine, endLine } = linesForAnchor(doc, a);
  const from = doc.line(startLine).from;
  const to = doc.line(endLine).to;
  return from >= to ? "" : doc.sliceString(from, to);
}

/** What a comment should now say, given where its anchor ended up. */
export interface AnchorState { startLine: number; endLine: number; quote: string }

export function stateForAnchor(doc: Text, a: Anchor): AnchorState {
  return { ...linesForAnchor(doc, a), quote: quoteForAnchor(doc, a) };
}

/** True when re-deriving would actually change the stored comment — the guard
 *  that keeps an edit far below a comment from churning the store. */
export function anchorStateChanged(
  stored: { startLine: number | null; endLine: number | null; quote: string },
  next: AnchorState,
): boolean {
  return stored.startLine !== next.startLine
    || stored.endLine !== next.endLine
    || stored.quote !== next.quote;
}
