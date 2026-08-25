import { describe, expect, it } from "vitest";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { astro, frontmatterRange } from "./astroMode";

/** The highlight classes the parse produces over `[from, to)`, which is what
 *  reaches the screen. Deliberately not a walk of the tree: an overlaid parse
 *  hangs off a mount that a plain `Tree.iterate` does not descend into, so a
 *  node walk reports "no TypeScript here" for a file that highlights fine. */
function classesIn(doc: string, from: number, to: number): Set<string> {
  const tree = astro().language.parser.parse(doc);
  const out = new Set<string>();
  highlightTree(tree, classHighlighter, (f, t, cls) => {
    if (t > from && f < to) out.add(cls);
  }, from, to);
  return out;
}

describe("frontmatterRange", () => {
  it("finds the block a fence opens and closes", () => {
    const doc = "---\nconst a = 1;\n---\n<p>x</p>\n";
    expect(frontmatterRange(doc)).toEqual({ from: 4, to: 16 });
    expect(doc.slice(4, 16)).toBe("const a = 1;");
  });

  it("ignores a fence that does not open on the first line", () => {
    // A horizontal rule in prose, and everything after it is NOT TypeScript.
    expect(frontmatterRange("<p>x</p>\n---\nnot code\n---\n")).toBeNull();
  });

  it("ignores a lookalike fence", () => {
    expect(frontmatterRange("---\nconst a = 1;\n---- \n")).toBeNull();
    expect(frontmatterRange("---\nconst a = 1;\n--- oops\n")).toBeNull();
  });

  it("refuses an unterminated block", () => {
    // Half-typed frontmatter must not turn the whole template into TypeScript.
    expect(frontmatterRange("---\nconst a = 1;\n<p>x</p>\n")).toBeNull();
  });

  it("takes the FIRST closing fence, not the last", () => {
    const doc = "---\nconst a = 1;\n---\n<p>a</p>\n---\n<p>b</p>\n";
    expect(frontmatterRange(doc)).toEqual({ from: 4, to: 16 });
  });

  it("accepts an empty block and a file that is only frontmatter", () => {
    expect(frontmatterRange("---\n---\n")).toBeNull();  // nothing to highlight
    expect(frontmatterRange("---\nconst a = 1;\n---")).toEqual({ from: 4, to: 16 });
  });
});

describe("astro()", () => {
  it("highlights the frontmatter as TypeScript", () => {
    const doc = "---\nimport L from './L.astro';\nconst n: number = 1;\n---\n<p>x</p>\n";
    const classes = classesIn(doc, 0, doc.indexOf("\n---\n"));
    // Plain HTML gives this whole region one Text node and no classes at all,
    // which is what "the frontmatter has no colour" looked like.
    expect(classes).toContain("tok-keyword");
    expect(classes).toContain("tok-string");
    // The type annotation, which is the half a JavaScript parser would drop.
    expect(classes).toContain("tok-typeName");
  });

  it("still highlights the template as HTML", () => {
    const doc = "---\nconst n = 1;\n---\n<Layout title={n}>\n<p>x</p>\n</Layout>\n";
    const classes = classesIn(doc, doc.indexOf("<Layout"), doc.length);
    // `classHighlighter` folds HTML's tag and attribute tags onto the general
    // type/property classes, so these two ARE the tag and the attribute name.
    expect(classes).toContain("tok-typeName");
    expect(classes).toContain("tok-propertyName");
  });

  it("keeps what it can when a < in the frontmatter ends the host node", () => {
    // The overlay is clipped to the Text node, and the HTML parser reads
    // `<string>` as a tag. Everything before it still gets TypeScript.
    const doc = "---\nconst n: number = 1;\nconst xs: Array<string> = [];\n---\n<p>x</p>\n";
    expect(classesIn(doc, 0, doc.indexOf("Array"))).toContain("tok-keyword");
  });

  it("leaves a file with no frontmatter as plain HTML", () => {
    const doc = "<p>x</p>\n";
    expect(classesIn(doc, 0, doc.length)).not.toContain("tok-keyword");
  });

  it("does not colour a half-typed block", () => {
    // Mid-edit, before the closing fence exists. Highlighting the rest of the
    // template as TypeScript on every keystroke until it lands would flash the
    // whole file a different colour.
    const doc = "---\nconst n = 1;\n<p>x</p>\n";
    expect(classesIn(doc, 0, doc.length)).not.toContain("tok-keyword");
  });
});
