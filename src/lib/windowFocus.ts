// Whether Termic's window has OS focus, as one synchronous fact.
//
// `isUserWatchingIn` decides whether a finished turn earns a badge, and it used
// to ask only whether a window EXISTS (`windowless`). A Termic open behind the
// user's browser therefore counted as watched, so an agent finishing while they
// were in another app was treated as already seen: no badge, no bell, and
// nothing waiting when they came back. The window existing is not the same as
// somebody looking at it.
//
// Installed once from main.tsx, next to the other window listeners.

import { useUI } from "@/store/ui";

let initialized = false;

/** `document.hasFocus()` is the truth; the events only say when to re-ask it.
 *  Inferring focus from which event arrived gets it wrong when they interleave
 *  (a blur and a visibilitychange during a Space switch), and the answer is
 *  cheap enough to just read. */
function sync(): void {
  let focused = true;
  try {
    focused = document.visibilityState !== "hidden" && document.hasFocus();
  } catch {
    // No document (tests, teardown). "Focused" is the conservative default:
    // it suppresses badges rather than inventing them.
  }
  useUI.getState().setWindowFocused(focused);
}

export function initWindowFocus(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
}
