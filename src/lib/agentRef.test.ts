import { describe, it, expect } from "vitest";
import { formatAgentRef } from "./agentRef";

// The reference string is the whole contract with the agent: it gets typed
// verbatim into a TUI prompt, so a dropped colon or an unescaped space is the
// difference between context and a broken mention.
describe("formatAgentRef", () => {
  it("references the whole file when no line is given", () => {
    expect(formatAgentRef("src/lib/foo.ts")).toBe("@src/lib/foo.ts ");
  });

  it("pins a single line", () => {
    expect(formatAgentRef("src/lib/foo.ts", 12)).toBe("@src/lib/foo.ts:12 ");
  });

  it("collapses a one-line range to the single-line form", () => {
    expect(formatAgentRef("src/lib/foo.ts", 12, 12)).toBe("@src/lib/foo.ts:12 ");
  });

  it("writes a range as start-end", () => {
    expect(formatAgentRef("src/lib/foo.ts", 12, 40)).toBe("@src/lib/foo.ts:12-40 ");
  });

  it("always ends in a space so the user's question continues the line", () => {
    for (const ref of [
      formatAgentRef("a.ts"),
      formatAgentRef("a.ts", 1),
      formatAgentRef("a.ts", 1, 9),
    ]) {
      expect(ref.endsWith(" ")).toBe(true);
    }
  });

  it("escapes a path the way a dragged file is escaped", () => {
    // Same convention as terminalDrop.shellEscapePath: spaces, parens and the
    // rest survive into the prompt instead of splitting the reference.
    expect(formatAgentRef("src/my file (old).ts", 3)).toBe("@src/my\\ file\\ \\(old\\).ts:3 ");
  });

  // Selections are live user state, so the numbers are normalized rather than
  // trusted — a reversed drag or a stale line must not emit "@f.ts:40-12".
  it("normalizes a reversed range", () => {
    expect(formatAgentRef("a.ts", 40, 12)).toBe("@a.ts:12-40 ");
  });

  it("floors fractional lines and clamps below 1", () => {
    expect(formatAgentRef("a.ts", 0, 3)).toBe("@a.ts:1-3 ");
    expect(formatAgentRef("a.ts", -5)).toBe("@a.ts:1 ");
    expect(formatAgentRef("a.ts", 2.7, 5.9)).toBe("@a.ts:2-5 ");
  });

  it("treats a non-finite line as no line at all", () => {
    expect(formatAgentRef("a.ts", NaN)).toBe("@a.ts ");
    expect(formatAgentRef("a.ts", 4, NaN)).toBe("@a.ts:4 ");
  });
});
