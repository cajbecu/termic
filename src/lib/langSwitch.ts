// Last-writer-wins for asynchronous grammar loads.
//
// Grammars come from CodeMirror's registry and are code-split, so resolving
// one is a chunk fetch that can take an arbitrary amount of time and can
// resolve out of order. Meanwhile an editor has several things racing to set
// its language: the initial load, a path change on a recycled preview tab, the
// content sniffer answering as a scratchpad fills, and the user picking from
// "Set syntax". Whichever STARTED last must win, regardless of which one's
// chunk happens to arrive first.
//
// A plain `alive` flag cannot express that — it only knows about unmount. This
// is the async-mount race the no-StrictMode rule exists for, one level up.

export interface LangSwitch {
  /** Start a load. The returned predicate answers "is this still the load
   *  whose result should be applied?", and goes false the moment anything
   *  else claims the switch. Call it after every await, not just the first. */
  claim(): () => boolean;
}

export function createLangSwitch(): LangSwitch {
  let current = 0;
  return {
    claim() {
      const mine = ++current;
      return () => mine === current;
    },
  };
}
