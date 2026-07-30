// The agent-working spinner. Deliberately NOT lucide's Loader2.
//
// Two things make a 12-14px stroked SVG arc wobble. Its geometry is drawn on a
// 24 grid, so at 14px the 2px stroke becomes ~1.17px and the 9 radius becomes
// ~5.25px: every rotation angle rasterizes to a slightly different lumpy ring,
// and `animate-spin` re-rasterizes 60 times a second, so the lumps travel. That
// reads as a shape that is not quite round. On top of that, the rotation is
// about the element's box centre, which sits on a half pixel whenever the flex
// row around it does, so the whole glyph orbits its own centre.
//
// A border-radius ring is symmetric by construction at any size, and the
// wrapper is promoted to its own compositing layer with `translate3d(0,0,0)`,
// which WebKit pixel-snaps (same trick, and the same reason, as Dialog's
// content box). The rotation centre therefore lands on a whole pixel.
//
// Keep `size` EVEN. An odd box has its centre on a half pixel by definition,
// which is the wobble this exists to remove.

import { cn } from "@/lib/utils";

export function Spinner({
  size = 12,
  className,
}: {
  /** Outer diameter in px. Even numbers only (see above). */
  size?: number;
  /** Applied to the wrapper. Colour comes from `currentColor`. */
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("block shrink-0 [transform:translate3d(0,0,0)]", className)}
      style={{ width: size, height: size }}
    >
      {/* 1.5px = 3 device pixels on a 2x display, so the ring lands on whole
          pixels there rather than straddling one. */}
      <span
        className="block h-full w-full animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
      />
    </span>
  );
}
