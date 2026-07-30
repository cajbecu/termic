// Lossless control-sequence recorder for signal archaeology.
//
// Teaching termic a new work-done / needs-you signal means first knowing what
// the agent actually emits, and the two debug paths in TerminalPane both drop
// the interesting cases: its inline `oscSniffer` regex only matches sequences
// that land whole inside one `onPtyData` chunk, and it deliberately skips the
// ids we already consume (OSC 0/1/2/9/1337) — so you can't tell "the agent
// sent nothing" from "a handler ate it". This filters nothing and survives
// chunk boundaries.
//
// Pure and dependency-free so it can be unit-tested without xterm or Tauri.
// Wired up only under `localStorage.ptyDebugRaw = "1"`.

/** Feed it raw PTY chunks in order; it calls `emit(kind, payload)` once per
 *  complete OSC / DCS / APC / PM string sequence and once per bare BEL.
 *  `kind` is the sequence name ("OSC", "DCS", "APC", "PM", "BEL"); `payload`
 *  is everything between the introducer and the terminator, verbatim. */
export function makeCtrlSniffer(emit: (kind: string, payload: string) => void) {
  const dec = new TextDecoder("utf-8", { fatal: false });
  // ESC ] = OSC, ESC P = DCS, ESC _ = APC, ESC ^ = PM. All string
  // sequences terminated by ST (ESC \) or, by xterm convention, BEL.
  const START = /\x1b[\]P_^]/;
  const END = /[\x07\x1b]/;
  const NAME: Record<string, string> = { "]": "OSC", P: "DCS", _: "APC", "^": "PM" };
  // A "sequence" that never terminates is a misparse (a lone ESC ] in
  // ordinary output). Give up rather than buffer forever.
  const MAX_PENDING = 16_384;
  let buf = "";

  const bells = (s: string) => {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0x07) emit("BEL", "");
  };

  return (u8: Uint8Array): void => {
    buf += dec.decode(u8, { stream: true });
    for (;;) {
      const s = buf.search(START);
      if (s < 0) {
        bells(buf);
        // Keep a trailing lone ESC: the introducer may be split across
        // this chunk and the next.
        buf = buf.endsWith("\x1b") ? "\x1b" : "";
        return;
      }
      bells(buf.slice(0, s));
      const kind = NAME[buf[s + 1]] ?? "?";
      const rest = buf.slice(s + 2);
      // ST is ESC \, so a bare ESC inside the payload would be a new
      // sequence starting — scan for either terminator and check which.
      let e = rest.search(END);
      while (e >= 0 && rest[e] === "\x1b" && rest[e + 1] !== undefined && rest[e + 1] !== "\\") {
        const next = rest.slice(e + 1).search(END);
        if (next < 0) { e = -1; break; }
        e = e + 1 + next;
      }
      // Terminator not here yet (or an ESC we can't classify until more
      // bytes arrive) — hold the partial sequence and wait.
      if (e < 0 || (rest[e] === "\x1b" && rest[e + 1] === undefined)) {
        buf = buf.slice(s);
        if (buf.length > MAX_PENDING) buf = "";
        return;
      }
      emit(kind, rest.slice(0, e));
      buf = rest.slice(e + (rest[e] === "\x07" ? 1 : 2));
    }
  };
}

