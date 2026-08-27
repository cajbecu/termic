import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// One focus indicator, defined once, in index.css.
//
// This used to be five components each rolling their own `focus-visible:ring-*`
// while everything else fell back to the browser's default outline: two looks,
// neither applied consistently, and the default one drawn OUTSIDE the box so it
// came out clipped on any control sitting flush against a container edge. The
// sandbox picker's first card, which its dialog autofocuses, was the visible
// case.
//
// If you are here because this test failed: do not re-add a per-component ring.
// Either the global rule in index.css needs to change (it is the convention, so
// changing it changes every control at once, which is the point), or your
// control genuinely needs different treatment, in which case say so in a comment
// and add it to ALLOWED below.

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "../index.css");
const srcDir = resolve(here, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

describe("focus indicator", () => {
  it("is defined exactly once, in index.css", () => {
    const css = readFileSync(cssPath, "utf8");
    const rules = css.match(/\):focus-visible\s*\{/g) ?? [];
    expect(rules).toHaveLength(1);
  });

  it("draws inside the box so no ancestor can clip it", () => {
    // A positive (or default) offset puts the outline outside the border box,
    // which is exactly the clipping this rule exists to fix.
    const css = readFileSync(cssPath, "utf8");
    const rule = css.slice(css.indexOf("):focus-visible"));
    expect(rule).toMatch(/outline-offset:\s*-\d/);
  });

  it("has no component defining its own focus ring", () => {
    const offenders = walk(srcDir)
      .filter((p) => /focus-visible:ring/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(srcDir.length + 1));
    expect(offenders).toEqual([]);
  });

});
