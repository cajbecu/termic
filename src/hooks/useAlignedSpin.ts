import { useEffect, useRef, useState } from "react";

/** Keep a CSS `animate-spin` class visible for a whole number of its
 *  rotation cycles, so turning it off never freezes the icon mid-turn.
 *  Tying `animate-spin` directly to an async operation's real duration cuts
 *  the animation off at an arbitrary point in its cycle - the icon snaps
 *  back to its own rest orientation from wherever it happened to be, which
 *  reads as a visible stutter/wobble, worse the smaller and more circular
 *  the icon is (a single reference point like a spinner's gap makes the
 *  jump obvious the same way a clock hand skipping is obvious).
 *
 *  `active` is the real busy state (e.g. a network call in flight).
 *  The returned boolean stays true until `active` has been held for at
 *  least one full `cycleMs` (Tailwind's `animate-spin` default: 1000ms),
 *  landing exactly on a cycle boundary - so pass it straight to the same
 *  `animate-spin` element instead of `active`. */
export function useAlignedSpin(active: boolean, cycleMs = 1000): boolean {
  const [display, setDisplay] = useState(active);
  const startedAt = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (startedAt.current === null) startedAt.current = Date.now();
      setDisplay(true);
      return;
    }
    if (startedAt.current === null) {
      setDisplay(false);
      return;
    }
    const elapsed = Date.now() - startedAt.current;
    const turns = Math.max(1, Math.ceil(elapsed / cycleMs));
    const wait = turns * cycleMs - elapsed;
    timer.current = window.setTimeout(() => {
      setDisplay(false);
      startedAt.current = null;
      timer.current = null;
    }, wait);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [active, cycleMs]);

  return display;
}
