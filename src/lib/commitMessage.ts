// Commit-message shaping, shared by every surface that renders one: the History
// panel's hover card and the editor's inline-blame popup. It lives in lib/
// rather than beside its first caller so the lazily-loaded editor chunk does not
// have to pull in the whole History panel to read a commit message.

/** Split a commit message body into its trailers and the prose above them.
 *
 *  Only `Co-authored-by:` is pulled out by name (it is the one every agent
 *  writes, and the one worth a line of its own); the rest of the trailer block
 *  is left in the prose, because a `Refs #12` line is part of what the author
 *  wrote and dropping it would hide it.
 *
 *  Case-insensitive: git's own trailer matching is, and agents disagree about
 *  the capital A. */
export function splitTrailers(body: string): { prose: string; coAuthors: string[] } {
  const coAuthors: string[] = [];
  const kept: string[] = [];
  for (const line of (body || "").split("\n")) {
    const m = /^\s*co-authored-by:\s*(.+?)\s*$/i.exec(line);
    if (!m) { kept.push(line); continue; }
    // "Name <email>" → "Name". A bare email keeps its angle brackets off.
    const name = m[1].replace(/\s*<[^>]*>\s*$/, "").trim();
    if (name) coAuthors.push(name);
  }
  return { prose: kept.join("\n").trim(), coAuthors };
}
