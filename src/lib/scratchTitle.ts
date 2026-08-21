// Scratchpad tab titles (GH #244), derived from the buffer itself because a
// pad has no filename to take one from.
//
// This runs on the TYPING path (debounced in EditorPane), so both callers pair
// it with a bail on the unchanged value: writing an identical title through a
// store setter copies the whole app state and re-runs every mounted task's
// selectors for nothing (docs/performance.md bear trap 8).

/** Longest derived title. Past this a tab pill truncates with an ellipsis
 *  anyway, and the string is also written to the scratch index on every
 *  debounce tick. */
export const SCRATCH_TITLE_MAX = 40;

/** What an empty pad is called. Not "Untitled 1": the number would have to
 *  stay unique across restore, close and reorder, and two pads called
 *  "Untitled" are distinguishable the moment either gets a first line. */
export const SCRATCH_UNTITLED = "Untitled";

/** Title for a pad holding `content`: as much of the buffer as fits, read in
 *  order, whitespace collapsed and truncated to `SCRATCH_TITLE_MAX`.
 *
 *  Deliberately NOT just the first line. Notes are jotted, so the opening line
 *  is routinely a word or two ("asd", "todo", a bare `{`), and a pill reading
 *  "asd" tells you nothing about which of three pads you are looking at.
 *  Joining lines until the cap is reached spends the pill's whole width on
 *  content, so two pads that start the same are still told apart.
 *
 *  Markdown heading marks and comment leaders are stripped PER LINE, and blank
 *  lines and rules collapse away entirely: they are structure, and a pill can
 *  least afford the punctuation. */
export function deriveScratchTitle(content: string): string {
  const parts: string[] = [];
  let len = 0;
  for (const raw of content.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    // A rule or divider (`---`, `===`, `####`, `***`) is not title material.
    // Checked BEFORE the leader strip, which would otherwise leave `---`
    // intact (no space to anchor on).
    if (/^[-=_*#~]+$/.test(line)) continue;
    line = line.replace(/^(#{1,6}\s+|\/\/+\s*|\*\s+|-\s+|>\s+)/, "").trim();
    if (!line) continue;
    line = line.replace(/\s+/g, " ");
    parts.push(line);
    // +1 for the joining space. Stop as soon as there is enough to fill the
    // cap: reading the whole buffer to build a string that gets sliced to 40
    // chars would run on every debounce tick of a long note.
    len += line.length + 1;
    if (len > SCRATCH_TITLE_MAX) break;
  }
  if (!parts.length) return SCRATCH_UNTITLED;
  const joined = parts.join(" ");
  return joined.length > SCRATCH_TITLE_MAX
    // Trim the trailing space rather than leaving one before the ellipsis.
    ? `${joined.slice(0, SCRATCH_TITLE_MAX).trimEnd()}\u2026`
    : joined;
}

/** Filename the save picker prefills from a pad's title. Slugged, because the
 *  title is free text ("Fix the resume race" → "fix-the-resume-race") and the
 *  user is one keystroke from editing it anyway. */
export function scratchFilenameSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/…/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "untitled";
}
