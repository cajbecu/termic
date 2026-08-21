// Per-side git status → glyph, fill, ink and label for the one-letter chips
// the Git panel and Compare render on every changed file. Lives in lib/ (not
// inside GitPanel) so the two panels share ONE definition and a unit test can
// hold them to it — the chip is a SOLID fill with text on top, and a fill
// whose ink nobody checked is exactly how the "modified" chip ended up
// near-unreadable in the light theme.
//
// `?` is untracked, rendered as a green + like a fresh add.

export const SC: Record<string, string> = {
  M: "M", A: "+", "?": "+", D: "D", R: "R", C: "C", U: "U",
};

/** Chip background. Also used as a TEXT colour by the History panel, where the
 *  accent is the right choice because it is tuned for text on the app surface. */
export const COL: Record<string, string> = {
  M: "var(--color-status-mod)", A: "var(--color-ok)", "?": "var(--color-ok)",
  D: "var(--color-err)", R: "var(--color-status-mod)", C: "var(--color-status-mod)",
  U: "var(--color-err)",
};

/** Ink painted ON the fill above. Every dark theme's fills take black; the
 *  light theme's "modified" fill is the only one that needs its own ink, and
 *  `--color-status-mod-ink` is where it says so. Paired per status because the
 *  inks genuinely differ: white on light's deep terracotta reads at ~5.7:1,
 *  white on its green would be ~2.8:1. */
export const INK: Record<string, string> = {
  M: "var(--color-status-mod-ink)", A: "var(--color-status-ink)",
  "?": "var(--color-status-ink)", D: "var(--color-status-ink)",
  R: "var(--color-status-mod-ink)", C: "var(--color-status-mod-ink)",
  U: "var(--color-status-ink)",
};

export const LBL: Record<string, string> = {
  M: "modified", A: "added", "?": "untracked", D: "deleted", R: "renamed",
  C: "copied", U: "conflict",
};
