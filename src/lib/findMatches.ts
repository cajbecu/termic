// Match ranges for the find-in-files result rows. `git grep` reports only
// the column of the FIRST match on a line, so the frontend re-matches the
// preview to highlight every hit.
//
// In regex mode the two engines are NOT the same flavor: git runs POSIX ERE,
// `RegExp` runs ECMAScript. That is tolerable because this decides
// highlighting only, never which rows exist. POSIX-only syntax
// (`[[:digit:]]`, `\<`) leaves the row unhighlighted; ECMAScript-only syntax
// (`\d`, `(?:…)`) matches nothing in git, so there is no row to paint.

import type { GrepOpts } from "@/lib/ipc";

/** `[start, end)` ranges of `query` in `text`, under the same flags the
 *  search ran with. Literal mode escapes the metacharacters, so the query
 *  matches as typed. */
export function findRanges(text: string, query: string, opts: GrepOpts): Array<[number, number]> {
  if (!query) return [];
  let re: RegExp;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(src, opts.case_sensitive ? "g" : "gi");
  } catch {
    // Runs during render, and the user types a pattern one character at a
    // time — an unfinished `foo(` must not throw.
    return [];
  }
  const out: Array<[number, number]> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0]) out.push([m.index, m.index + m[0].length]);
    else re.lastIndex++;
  }
  return out;
}
