// What EditorPane does with a failed `taskFileRead`. Two outcomes, and the
// split matters visually: a binary file is not a failure, it is the WRONG
// VIEWER, so it gets a calm centered notice with a way out (open in the OS
// default app / reveal in the file manager). Anything else — missing file,
// permission denied, IO error — is a real failure and keeps the red raw
// message, because offering "Open in default app" on a file that would not
// read is offering a button that fails again.
//
// Split from the component so the rule is testable without mounting React
// (and so the sibling panes can adopt it later without copying the regex).
//
// The `binary` detection is a LOOSE match against the message Rust returns
// from `task_file_read` ("file is not valid UTF-8", src-tauri/src/lib.rs).
// That cross-language coupling is pinned by a Rust test, so a reword there
// fails `cargo test` instead of silently dropping this pane back to the raw
// error. Deliberately loose: it should survive "invalid UTF-8" too.

/** Copy for the binary case. Says "here", not "at all": the file is fine,
 *  this viewer is not, and the two buttons under it are the way out. */
export const BINARY_NOTICE = "This looks like a binary file, so the editor can't show it.";

export type EditorLoadError =
  /** Not decodable as text. Calm notice + OS actions. */
  | { kind: "binary"; message: string }
  /** A genuine read failure. Raw message, red. */
  | { kind: "raw"; message: string };

/** Classify a rejected `taskFileRead`. Never throws; anything unrecognised
 *  falls through to `raw`, so a new Rust failure mode is still surfaced. */
export function classifyEditorLoadError(e: unknown): EditorLoadError {
  const message = String(e);
  return /valid UTF-8/i.test(message)
    ? { kind: "binary", message: BINARY_NOTICE }
    : { kind: "raw", message };
}
