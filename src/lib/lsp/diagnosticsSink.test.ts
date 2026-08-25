import { describe, expect, it, beforeEach, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { applyDiagnostics, forgetDiagnostics } from "./diagnosticsSink";
import { setDiagnosticsEnabled } from "./diagnosticsPref";

// The type-checking switch, which ships OFF and is labelled Experimental. Its
// whole contract is that it works in BOTH directions on what is already on
// screen: off clears the underlines, on brings back what the server already
// said. A server that pushes says it once, at open, so "on" that only affected
// the next message left the file clean until you typed in it, which reads as
// the switch doing nothing.

// `setDiagnostics` is MOCKED to hand back the list it was given. The unit
// under test is which diagnostics this module passes on and when, not how
// CodeMirror encodes them: asserting against real lint effects means decoding
// StateField internals, which tests the library rather than the decision.
vi.mock("@codemirror/lint", () => ({
  setDiagnostics: (_state: unknown, diagnostics: unknown[]) => ({ diagnostics }),
}));

/** A view that records the diagnostic lists dispatched into it. */
function fakeView(connected = true) {
  const dispatched: unknown[][] = [];
  const view = {
    dom: { isConnected: connected },
    state: {},
    dispatch: (spec: { diagnostics: unknown[] }) => void dispatched.push(spec.diagnostics),
    dispatched,
  };
  return view as unknown as EditorView & { dispatched: unknown[][] };
}

const diag = (message: string) => ({ from: 0, to: 3, severity: "error" as const, message });

describe("the diagnostics sink", () => {
  beforeEach(() => setDiagnosticsEnabled(false));

  it("shows nothing while type checking is off", () => {
    const view = fakeView();
    applyDiagnostics(view, [diag("boom")]);
    expect((view as any).dispatched.at(-1)).toEqual([]);
  });

  it("shows what the server said once it is on", () => {
    setDiagnosticsEnabled(true);
    const view = fakeView();
    applyDiagnostics(view, [diag("boom")]);
    expect((view as any).dispatched.at(-1)).toHaveLength(1);
  });

  it("re-applies what a PUSHING server already said when the switch goes on", () => {
    // The regression this exists for: a pushing server publishes at open and
    // says nothing again, so remembering the last set is the only way "on" can
    // mean anything before the next keystroke.
    const view = fakeView();
    applyDiagnostics(view, [diag("boom"), diag("bang")]);
    expect((view as any).dispatched.at(-1)).toEqual([]);

    setDiagnosticsEnabled(true);
    expect((view as any).dispatched.at(-1)).toHaveLength(2);
  });

  it("clears the screen when the switch goes off", () => {
    setDiagnosticsEnabled(true);
    const view = fakeView();
    applyDiagnostics(view, [diag("boom")]);
    setDiagnosticsEnabled(false);
    expect((view as any).dispatched.at(-1)).toEqual([]);
  });

  it("does not dispatch into a view that has left the DOM", () => {
    // A closed tab. Dispatching into it is not fatal, but the entry would
    // otherwise pin the view (and its document) for the life of the session.
    const gone = fakeView(false);
    applyDiagnostics(gone, [diag("boom")]);
    const before = (gone as any).dispatched.length;
    setDiagnosticsEnabled(true);
    expect((gone as any).dispatched.length).toBe(before);
    // And it is forgotten, so a later toggle does not walk it again.
    setDiagnosticsEnabled(false);
    expect((gone as any).dispatched.length).toBe(before);
  });

  it("forgets a view on request", () => {
    const view = fakeView();
    applyDiagnostics(view, [diag("boom")]);
    forgetDiagnostics(view);
    const before = (view as any).dispatched.length;
    setDiagnosticsEnabled(true);
    expect((view as any).dispatched.length).toBe(before);
  });
});
