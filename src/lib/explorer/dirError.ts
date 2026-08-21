// Turn a rejected `task_dir_list` into something a user can act on (GH #250).
//
// #159 gave a failed directory read a retry row instead of a "Loading…" that
// never resolved, but the row said "Couldn't read this folder" and nothing
// else, so the follow-up report had no more information in it than the bug it
// replaced. The raw error is a Rust `io::Error` string ("Permission denied
// (os error 13)") or one of the containment checks in `safe_task_path`, both
// of which name the actual cause once you can see them.
//
// `short` is the headline the row shows; `detail` is the raw message, shown
// underneath and in the title, because the errno and the resolved path are
// what make a report like #250 diagnosable.

export interface DirError {
  /** Human headline, no trailing period (the row adds its own separator). */
  short: string;
  /** The raw error, kept verbatim for the tooltip and the second line. */
  detail: string;
}

const RULES: Array<[RegExp, string]> = [
  // A symlinked folder pointing outside the task. It always fails, and no
  // amount of retrying changes that, so say so instead of offering hope.
  [/path escapes task/i, "This folder links outside the task"],
  [/`\.\.` segments not allowed|absolute paths not allowed/i, "Path not allowed"],
  [/os error 2\b|no such file or directory/i, "This folder no longer exists"],
  [/os error 13\b|permission denied/i, "Permission denied"],
  [/os error 20\b|not a directory/i, "This is not a folder any more"],
  [/os error 62\b|too many levels of symbolic links/i, "Symlink loop"],
  [/os error 24\b|too many open files/i, "Too many open files"],
  [/^no task\b/i, "This task is gone from disk"],
];

/** Classify a `task_dir_list` rejection. `e` is whatever the promise rejected
 *  with: Tauri hands back the Rust `Err(String)`, but an exception from the
 *  bridge itself is possible too, so everything goes through `String()`. */
export function explainDirError(e: unknown): DirError {
  const detail = (typeof e === "string" ? e : e instanceof Error ? e.message : String(e)).trim();
  for (const [re, short] of RULES) if (re.test(detail)) return { short, detail };
  // Unrecognised: the raw message IS the headline. Better a cryptic errno on
  // screen than the generic sentence that made #250 unactionable.
  return { short: detail || "Unknown error", detail };
}
