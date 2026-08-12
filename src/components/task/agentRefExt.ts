// Editor selection → "Send to agent" affordance (roadmap item 8, GH #174).
//
// A floating button over any non-empty selection, the same shape as the diff
// pane's "＋ Comment on lines X-Y" tooltip. A CodeMirror tooltip rather than a
// right-click menu on purpose: a Radix ContextMenuTrigger wrapping the editor
// host would swallow right-click across the whole document (including the
// WebView's own selection menu), for one action that only ever applies to a
// selection. The tooltip is scoped to exactly the state where it is useful.
//
// The extension knows nothing about agents or the store: it reports the
// selected line range and lets the caller do the sending.

import { EditorState, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";

/** Called with the 1-based, doc-clamped line range the user selected. */
export type SendSelection = (startLine: number, endLine: number) => void;

/** The selected line range, clamped to the live doc, or null when the
 *  selection is empty. Exported for the keyboard path (EditorPane), which
 *  needs the same numbers without going through the tooltip. */
export function selectedLineRange(state: EditorState): { startLine: number; endLine: number } | null {
  const range = state.selection.main;
  if (range.empty) return null;
  const last = state.doc.lines;
  const startLine = Math.max(1, Math.min(state.doc.lineAt(range.from).number, last));
  const endLine = Math.max(startLine, Math.min(state.doc.lineAt(range.to).number, last));
  return { startLine, endLine };
}

function refTooltips(state: EditorState, onSend: SendSelection): readonly Tooltip[] {
  const lines = selectedLineRange(state);
  if (!lines) return [];
  const { startLine, endLine } = lines;
  return [{
    pos: state.selection.main.from,
    above: true,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "tc-agent-ref-tip";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tc-agent-ref-btn";
      btn.dataset.testid = "send-selection-to-agent";
      btn.textContent = endLine > startLine
        ? `Send lines ${startLine}-${endLine} to agent`
        : `Send line ${startLine} to agent`;
      // mousedown + preventDefault, so the editor doesn't clear the selection
      // out from under us before the click lands.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        // Re-read from the LIVE doc: the tooltip was built from an older
        // state, and an agent edit could have shrunk the file since.
        const fresh = selectedLineRange(view.state);
        if (!fresh) return;
        onSend(fresh.startLine, fresh.endLine);
      });
      dom.appendChild(btn);
      return { dom };
    },
  }];
}

const baseTheme = EditorView.baseTheme({
  ".tc-agent-ref-tip": {
    background: "transparent",
    border: "none",
    // CodeMirror's tooltip layer sits above the editor; the button carries the
    // whole visual so the wrapper never paints a second surface behind it.
    padding: "0 0 4px 0",
  },
  ".tc-agent-ref-btn": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    borderRadius: "6px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-2)",
    color: "var(--color-fg)",
    font: "inherit",
    fontSize: "12px",
    lineHeight: "1.2",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.28)",
  },
  ".tc-agent-ref-btn:hover": {
    background: "var(--color-accent)",
    borderColor: "var(--color-accent)",
    color: "var(--color-accent-fg)",
  },
});

/** Selection tooltip that hands the selected line range to `onSend`. */
export function agentRefExtension(onSend: SendSelection) {
  const tooltipField = StateField.define<readonly Tooltip[]>({
    create: (state) => refTooltips(state, onSend),
    update(tips, tr) {
      // Selection-only transactions are the common case here, so recompute on
      // either a selection change or a doc change and skip everything else
      // (scroll, focus, decoration churn).
      if (!tr.docChanged && !tr.selection) return tips;
      return refTooltips(tr.state, onSend);
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });
  return [tooltipField, baseTheme];
}
