// Ordering + selection rules behind the tab context menu (issue #183).
//
// Typed on the smallest shape a tab strip has in common, so the main strip
// (`Tab[]`), a split pane's strip (`Tab[]`) and the bottom scratch shells
// (their own `{ id, title }` records) all share one implementation.

export interface StripTab {
  id: string;
  pinned?: boolean;
}

/** Where the pinned block ends, ignoring `tabId` itself. Chrome semantics: this
 *  is the destination for BOTH pin (append to the block) and unpin (first slot
 *  after it). */
export function pinBoundary(strip: StripTab[], tabId: string): number {
  return strip.filter(t => t.id !== tabId && t.pinned).length;
}

/** Tabs "Close others" / "Close to the right" should close. Pinned tabs and the
 *  clicked tab itself always survive. Empty when the clicked tab is unknown. */
export function closableSiblings(strip: StripTab[], tabId: string, mode: "others" | "right"): string[] {
  const idx = strip.findIndex(t => t.id === tabId);
  if (idx < 0) return [];
  const candidates = mode === "right" ? strip.slice(idx + 1) : strip;
  return candidates.filter(t => t.id !== tabId && !t.pinned).map(t => t.id);
}
