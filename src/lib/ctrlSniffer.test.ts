import { describe, expect, it } from "vitest";
import { makeCtrlSniffer } from "./ctrlSniffer";

const enc = new TextEncoder();

/** Feed `s` as one chunk per element of `splits` (byte offsets), so a test can
 *  reproduce the exact thing the old regex sniffer got wrong: a sequence torn
 *  in half by the PTY read boundary. */
function run(s: string, splits: number[] = []): string[] {
  const out: string[] = [];
  const sniff = makeCtrlSniffer((kind, payload) => out.push(`${kind} ${payload}`));
  const bytes = enc.encode(s);
  const bounds = [...splits, bytes.length];
  let prev = 0;
  for (const b of bounds) {
    if (b > prev) sniff(bytes.slice(prev, b));
    prev = b;
  }
  return out;
}

describe("makeCtrlSniffer", () => {
  it("reports BEL-terminated and ST-terminated sequences alike", () => {
    expect(run("\x1b]0;hello\x07")).toEqual(["OSC 0;hello"]);
    expect(run("\x1b]0;hello\x1b\\")).toEqual(["OSC 0;hello"]);
  });

  it("reports the ids TerminalPane already consumes", () => {
    // The whole point: OSC 9 / 0 / 2 / 1337 are handled by dedicated handlers
    // and skipped by the inline oscSniffer, so a recording made with that one
    // can't distinguish "agent emitted nothing" from "we swallowed it".
    expect(run("\x1b]9;4;3\x07\x1b]2;spinner\x07\x1b]1337;RequestAttention=fg\x07"))
      .toEqual(["OSC 9;4;3", "OSC 2;spinner", "OSC 1337;RequestAttention=fg"]);
  });

  it("reassembles a sequence split across chunks, anywhere", () => {
    const seq = "\x1b]9;Claude needs your permission\x07";
    for (let i = 1; i < seq.length; i++) {
      expect(run(seq, [i])).toEqual(["OSC 9;Claude needs your permission"]);
    }
  });

  it("reassembles across three chunks and a split ST terminator", () => {
    expect(run("\x1b]777;notify;a;b\x1b\\", [2, 8, 17])).toEqual(["OSC 777;notify;a;b"]);
  });

  it("distinguishes DCS / APC / PM from OSC", () => {
    expect(run("\x1bP+q544e\x1b\\\x1b_Gf=100\x1b\\\x1b^msg\x1b\\"))
      .toEqual(["DCS +q544e", "APC Gf=100", "PM msg"]);
  });

  it("reports bare BELs, including between sequences", () => {
    expect(run("hi\x07there\x1b]0;t\x07\x07")).toEqual(["BEL ", "OSC 0;t", "BEL "]);
  });

  it("does not mistake a BEL inside a payload for a bare bell", () => {
    expect(run("\x1b]9;done\x07\x1b]9;more\x07")).toEqual(["OSC 9;done", "OSC 9;more"]);
  });

  it("passes CSI and ordinary text through without emitting", () => {
    expect(run("\x1b[2J\x1b[1;1Hplain text \x1b[38;2;255;0;0m")).toEqual([]);
  });

  it("gives up on an unterminated introducer instead of buffering forever", () => {
    const out: string[] = [];
    const sniff = makeCtrlSniffer((k, p) => out.push(`${k} ${p}`));
    // 20 KB of payload with no terminator: past MAX_PENDING the partial is
    // dropped, so the NEXT real sequence still gets reported.
    sniff(enc.encode("\x1b]0;" + "x".repeat(20_000)));
    sniff(enc.encode("\x1b]9;after\x07"));
    expect(out).toEqual(["OSC 9;after"]);
  });

  it("handles multi-byte UTF-8 split across a chunk boundary", () => {
    // Claude's titles lead with ✳ (3 bytes) and Braille spinner frames.
    const bytes = enc.encode("\x1b]2;✳ termic\x07");
    const out: string[] = [];
    const sniff = makeCtrlSniffer((k, p) => out.push(`${k} ${p}`));
    sniff(bytes.slice(0, 6));   // mid-✳
    sniff(bytes.slice(6));
    expect(out).toEqual(["OSC 2;✳ termic"]);
  });
});
