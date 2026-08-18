// Terse relative age for a commit timestamp. Lives in lib/ rather than beside
// its first caller because two very different surfaces format the same commit
// and must agree: the History panel's row, and the editor's inline blame
// annotation. Importing it from HistoryPanel.tsx would also pull that whole
// component into the lazily-loaded editor chunk.

/** "now" / "14m" / "3h" / "6d" / "8 Mar" — terse, because it sits at the right
 *  edge of a narrow row. Anything older than a year carries the year. */
export function commitAge(unixSeconds: number, now = Date.now()): string {
  const secs = Math.floor(now / 1000 - unixSeconds);
  if (!Number.isFinite(secs)) return "";
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}
