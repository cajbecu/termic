// Jump an editor to a 1-based line/col. One implementation, because three
// features now land on the same spot from different directions: Find-in-Files,
// inline blame's "open at this line", and LSP go-to-definition (GH #174).
// Two copies would drift on the parts that are easy to get wrong — clamping a
// stale line, and focusing a view that is not on screen yet.

import { EditorView } from "@codemirror/view";

/**
 * Scroll to a line, put the cursor there, and focus.
 *
 * Centers the line vertically. Clamps to the document bounds so a grep hit (or
 * an LSP location) pointing past the end of a file that has since shrunk moves
 * the cursor rather than throwing.
 */
export function gotoLocation(view: EditorView, line: number, col?: number) {
  const doc = view.state.doc;
  const safe = Math.max(1, Math.min(line, doc.lines));
  const lineObj = doc.line(safe);
  const pos = col && col > 0
    ? Math.min(lineObj.from + col - 1, lineObj.to)
    : lineObj.from;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  // Defer focus — a lazily mounted editor is not laid out yet, and focus()
  // on an unlaid-out view silently no-ops. A timer, not requestAnimationFrame:
  // rAF is frozen while the window is occluded, which is exactly when a jump
  // arrives from a background agent's find (see docs/gotchas.md).
  window.setTimeout(() => view.focus(), 0);
}
