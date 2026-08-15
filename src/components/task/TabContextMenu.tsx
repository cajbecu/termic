// Right-click menu on a tab pill (issue #183). Shared by all three strips: the
// main TabBar, a split pane's PaneHeader, and TaskView's bottom scratch shells.
// Each host supplies its own strip and its own close/pin wiring; the item set
// and the "which siblings does this close" rules live here.

import type { ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";
import {
  ContextMenuRoot, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/ContextMenu";
import { closableSiblings, type StripTab } from "@/lib/tabActions";

export function TabContextMenu({ tabs, tabId, pinned, onPin, onUnpin, onClose, onCloseMany, children }: {
  /** This strip's tabs, in display order. */
  tabs: StripTab[];
  tabId: string;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onClose: () => void;
  onCloseMany: (tabIds: string[]) => void;
  children: ReactNode;
}) {
  const others = closableSiblings(tabs, tabId, "others");
  const right = closableSiblings(tabs, tabId, "right");
  return (
    <ContextMenuRoot>
      {/* `contents` rather than asChild: TabPill neither forwards a ref nor
          spreads unknown props, so Radix's Slot would drop them. A
          display:contents span generates no box, so the pill stays the strip's
          flex item and the contextmenu event still bubbles through. */}
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {pinned ? (
          <ContextMenuItem onSelect={onUnpin}><PinOff /> Unpin</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={onPin}><Pin /> Pin</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}><X /> Close</ContextMenuItem>
        <ContextMenuItem disabled={!others.length} onSelect={() => onCloseMany(others)}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem disabled={!right.length} onSelect={() => onCloseMany(right)}>
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
