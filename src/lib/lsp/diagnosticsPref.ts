// Whether the language server's type errors are shown, readable from code that
// must not import the prefs store.
//
// The gate lives on both diagnostics paths (`workspace.ts` for servers that
// push, `pullDiagnostics.ts` for servers that are asked), and both are reached
// from `host.ts`, which several node-environment tests import. `prefs.ts`
// applies the theme to `document.documentElement` at import time, so importing
// it from here dragged a DOM requirement into the import graph of every one of
// those tests: three files stopped even loading.
//
// So the value is mirrored INTO this module instead, by the store that owns
// it. A plain module-level boolean, no store, no subscription: it is read at
// the moment a diagnostic arrives, which is exactly when the current value is
// wanted, and it defaults to off, which is also the app's default.
let enabled = false;

const listeners = new Set<(v: boolean) => void>();

/** Called by prefs.ts on load and on every change. */
export function setDiagnosticsEnabled(v: boolean) {
  if (enabled === v) return;
  enabled = v;
  for (const fn of listeners) fn(v);
}

/**
 * Run `fn` whenever the switch moves, and stop with the returned function.
 *
 * Turning it on has to show what is already known, not what arrives next. A
 * server that PUSHES sends its diagnostics once, at open: without this,
 * switching type checking on left the file clean until you typed in it, which
 * reads as the switch being broken.
 */
export function onDiagnosticsPrefChange(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Are the server's type errors and warnings wanted at all? */
export function diagnosticsEnabled(): boolean {
  return enabled;
}
