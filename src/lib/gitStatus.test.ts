import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COL, INK, LBL, SC } from "./gitStatus";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");

describe("git status chips", () => {
  it("describes every status in all four maps", () => {
    // A status with a glyph but no ink renders black-on-whatever by accident,
    // which is the bug this file exists to stop coming back.
    const keys = Object.keys(SC).sort();
    for (const map of [COL, INK, LBL]) expect(Object.keys(map).sort()).toEqual(keys);
  });

  it("paints from theme tokens only", () => {
    // Hard-coded colours here can't follow a theme, and the chip is a fill:
    // the light theme is a different fill AND a different ink, not a tweak.
    for (const v of [...Object.values(COL), ...Object.values(INK)])
      expect(v).toMatch(/^var\(--color-[a-z-]+\)$/);
  });

  it("has every token it names defined in the stylesheet", () => {
    for (const v of [...Object.values(COL), ...Object.values(INK)]) {
      const token = v.slice("var(".length, -1);
      expect(css.includes(`${token}:`), `${token} is used but never defined`).toBe(true);
    }
  });

  it("gives the light theme its own modified fill and ink", () => {
    // The reported bug: light darkens --color-accent for text on cream, so
    // the chip that fills with it left black ink at ~5:1 and muddy at 10.5px.
    const light = css.slice(css.indexOf("html.light {"));
    const block = light.slice(0, light.indexOf("}"));
    expect(block).toContain("--color-status-mod:");
    expect(block).toContain("--color-status-mod-ink:");
  });
});
