// The one place a diagnostic reaches the editor.
//
// Both models arrive here: a server that PUSHES (workspace.ts) and one that is
// ASKED (pullDiagnostics.ts). Routing them through one function is what makes
// the type-checking switch honest in both directions. Turning it off clears
// what is on screen, and turning it on shows what the server already said,
// rather than waiting for the next edit to shake it loose.
//
// The cache is a plain Map rather than a WeakMap because it has to be
// ITERATED when the switch moves; entries for views that have left the DOM are
// dropped at that moment, which is the only time it grows.
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { diagnosticsEnabled, onDiagnosticsPrefChange } from "./diagnosticsPref";

const lastSeen = new Map<EditorView, readonly Diagnostic[]>();

/** Hand the editor what the server said, subject to the switch. */
export function applyDiagnostics(view: EditorView, diagnostics: readonly Diagnostic[]) {
  lastSeen.set(view, diagnostics);
  view.dispatch(setDiagnostics(view.state, diagnosticsEnabled() ? [...diagnostics] : []));
}

/** Forget a view that is going away, so a closed tab cannot be re-dispatched
 *  into. */
export function forgetDiagnostics(view: EditorView) {
  lastSeen.delete(view);
}

onDiagnosticsPrefChange((on) => {
  for (const [view, diagnostics] of [...lastSeen]) {
    // A view whose DOM has left the document is gone; dispatching into it
    // throws nothing but keeps the entry alive forever.
    if (!view.dom.isConnected) {
      lastSeen.delete(view);
      continue;
    }
    view.dispatch(setDiagnostics(view.state, on ? [...diagnostics] : []));
  }
});
