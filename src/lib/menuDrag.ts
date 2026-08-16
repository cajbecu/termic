// "Carry this tab" drag session started from a context-menu click rather
// than a mousedown: there's no button held to release, so the ghost follows
// the cursor from wherever the menu closed and the user's NEXT click commits
// wherever it lands (Escape cancels). Reuses the same ghost + edge highlight
// as a real pointer drag (useTabStripDrag / PaneHeader's startTabDrag) so it
// reads as the same gesture, just without the initial grab.

import { showDragGhost, moveDragGhost, hideDragGhost } from "@/lib/dragGhost";
import { setDropHighlight, clearDropHighlight, type DropZone } from "@/lib/dropZones";

export interface MenuDragTarget {
  el: HTMLElement | null;
  toPaneId: string | null;
  zone: DropZone;
}

export function startMenuDrag(opts: {
  label: string;
  x: number;
  y: number;
  hitTest: (clientX: number, clientY: number) => MenuDragTarget | null;
  onDrop: (target: MenuDragTarget) => void;
}): void {
  let highlighted: HTMLElement | null = null;
  showDragGhost(opts.label, opts.x, opts.y);

  function clearHighlight() {
    if (highlighted) { clearDropHighlight(highlighted); highlighted = null; }
  }
  function onMove(e: PointerEvent) {
    moveDragGhost(e.clientX, e.clientY);
    clearHighlight();
    const target = opts.hitTest(e.clientX, e.clientY);
    if (target?.el) { setDropHighlight(target.el, target.zone); highlighted = target.el; }
  }
  // The next pointerdown anywhere commits the drop. Captured so it never
  // reaches whatever's underneath (a tab pill, a close button) and fires
  // that element's own handler too.
  function onCommit(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const target = opts.hitTest(e.clientX, e.clientY);
    cleanup();
    if (target) opts.onDrop(target);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") cleanup();
  }
  function cleanup() {
    hideDragGhost();
    clearHighlight();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", onCommit, true);
    window.removeEventListener("keydown", onKeyDown, true);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerdown", onCommit, true);
  window.addEventListener("keydown", onKeyDown, true);
}
