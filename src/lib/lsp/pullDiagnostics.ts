// Pull diagnostics (GH #174), because half the servers never push.
//
// `@codemirror/lsp-client` implements PUSH only
// (`textDocument/publishDiagnostics`) while advertising pull support. Both
// halves of that are wrong for us, and each fails silently:
//
//  - **TypeScript 7 never pushes.** Nor do Kotlin, ruby-lsp or Roslyn. A
//    push-only client shows zero squiggles on a file full of type errors, with
//    nothing in any log to say why. Measured: TS 7.0.2 pushes 0 and answers a
//    pull with 1 on a one-line type error.
//  - **ty stops pushing when a client CLAIMS pull.** So does zuban, and
//    ruff-server. Measured on ty 0.0.73: 0 diagnostics with the claim, 2
//    without it. The Rust host therefore withdraws the claim from
//    `initialize` (see lsp_patch_initialize), and this module polls anyway —
//    a server that really does pull advertises its provider regardless.
//
// So: handle push (the client's own handler, fanned out in workspace.ts), and
// poll whatever advertises `diagnosticProvider`. Claim what we do, poll what
// they offer.

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { diagnosticsEnabled, onDiagnosticsPrefChange } from "./diagnosticsPref";
import { applyDiagnostics, forgetDiagnostics } from "./diagnosticsSink";
import { attribution, severityOf } from "./diagnosticMap";

/** How long after the last keystroke to re-ask. Long enough that typing a
 *  line does not fire a request per character, short enough that the squiggle
 *  arrives while you are still looking at the line. */
const DEBOUNCE_MS = 600;

type FullReport = {
  kind: "full";
  resultId?: string;
  items: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    message: string;
    source?: string;
    /** The server's rule id: mypy's `assignment`, TypeScript's `2322`. */
    code?: string | number;
  }>;
};
type UnchangedReport = { kind: "unchanged"; resultId: string };

/**
 * A view plugin that asks the server for this document's diagnostics on open
 * and after every (debounced) edit, and applies them to this view.
 */
export const pullDiagnostics = ViewPlugin.fromClass(class {
  timer: number | null = null;
  /** The server's own cache key. Passing it back lets a server answer
   *  "unchanged", which is one round trip instead of a document's worth of
   *  ranges on every keystroke. */
  resultId: string | undefined;
  disposed = false;
  /** Whether this view currently shows any, so the pref going off can clear
   *  them exactly once instead of dispatching an empty set on every tick. */
  hadDiagnostics = false;

  /** Undo the pref subscription when the view goes. */
  unsubscribe: () => void;

  constructor(readonly view: EditorView) {
    this.schedule(0);
    // Switching type checking ON has to ask, not wait for the next keystroke.
    this.unsubscribe = onDiagnosticsPrefChange(on => { if (on) this.schedule(0); });
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.schedule(DEBOUNCE_MS);
  }

  destroy() {
    this.disposed = true;
    this.unsubscribe();
    forgetDiagnostics(this.view);
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  schedule(delay: number) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    // A timer, not requestAnimationFrame: rAF is frozen while the window is
    // occluded, which is exactly when an agent is editing the file you have
    // open (docs/gotchas.md).
    this.timer = window.setTimeout(() => { void this.run(); }, delay);
  }

  async run() {
    const plugin = LSPPlugin.get(this.view);
    if (!plugin) return;
    // Type checking is opt-in (prefs.codeIntelDiagnostics). Not asking at all
    // is the cheap half of that: a pull is a request per document per edit
    // pause, and a server that is never asked never spends the CPU. The push
    // side is filtered in workspace.ts, because a pushing server sends them
    // whether or not anybody asked.
    // Not asking at all is the cheap half of the switch: a pull is a request
    // per document per edit pause, and a server that is never asked never
    // spends the CPU. The sink handles what is already on screen.
    if (!diagnosticsEnabled()) return;
    const client = plugin.client;
    try {
      await client.initializing;
    } catch {
      return;   // the server never came up; nothing to poll
    }
    if (this.disposed) return;
    // Servers that only push advertise no provider, and asking them would be
    // an error reply per document per keystroke.
    if (!client.serverCapabilities?.diagnosticProvider) return;
    // The server's model has to have seen the edits, or it answers about the
    // document it last knew.
    client.sync();
    let report: FullReport | UnchangedReport | null = null;
    try {
      report = await client.request<unknown, FullReport | UnchangedReport>(
        "textDocument/diagnostic",
        { textDocument: { uri: plugin.uri }, previousResultId: this.resultId },
      );
    } catch {
      // -32801 ContentModified is normal here: the document changed while the
      // server was answering, and the next debounce covers it.
      return;
    }
    if (this.disposed || !report) return;
    if (report.kind === "unchanged") {
      this.resultId = report.resultId;
      return;
    }
    this.resultId = report.resultId;
    const doc = this.view.state.doc;
    const at = (p: { line: number; character: number }) => {
      // Clamp: the report describes the document the server last synced, and
      // the user may have deleted lines since.
      const line = doc.line(Math.max(1, Math.min(p.line + 1, doc.lines)));
      return Math.min(line.from + p.character, line.to);
    };
    const diagnostics: Diagnostic[] = report.items.map(item => ({
      from: at(item.range.start),
      to: Math.max(at(item.range.start), at(item.range.end)),
      severity: severityOf(item.severity),
      source: attribution(item.source, item.code),
      message: item.message,
    }));
    this.hadDiagnostics = diagnostics.length > 0;
    applyDiagnostics(this.view, diagnostics);
  }
});
