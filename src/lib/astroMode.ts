// Astro, which no published CodeMirror grammar covers.
//
// An `.astro` file is two languages stacked: a TypeScript frontmatter block
// fenced by `---`, then an HTML-with-expressions template. Treating the whole
// thing as HTML (what termic did, and what the overlay in `languageExts` still
// does for the other template formats) leaves the frontmatter grey: it is the
// part of the file that is actual code, and it was the part with no colour.
//
// So: the HTML parser, with the frontmatter region OVERLAID by the TypeScript
// one. Overlay rather than a replacement, because the outer parse still has to
// cover the whole document for folding, indentation and the tag matching that
// the template half depends on.
//
// Not a full Astro grammar. `{expressions}` in the template are parsed as
// plain attribute values or text, exactly as they are in every other format
// under the HTML overlay, and component tags highlight as tags. The
// frontmatter is where the difference was worth the code.

import { parseMixed, type SyntaxNodeRef, type Input } from "@lezer/common";
import { LanguageSupport } from "@codemirror/language";
import { html, htmlLanguage } from "@codemirror/lang-html";
import { typescriptLanguage } from "@codemirror/lang-javascript";

/** How far in we look for the closing fence. A frontmatter block is a handful
 *  of imports and consts; reading the whole document on every parse to find a
 *  delimiter that is never far from the top would be paid on every keystroke
 *  in a large file. */
const SCAN_LIMIT = 64 * 1024;

/**
 * The TypeScript region of an Astro file, or null when there is not one.
 *
 * Exported for the test: the interesting cases are all about where the block
 * ends, and driving them through a full parse tree would say much less about
 * what went wrong.
 */
export function frontmatterRange(text: string): { from: number; to: number } | null {
  // The fence has to open on line one, column one. A `---` anywhere else is a
  // horizontal rule in some prose, or the end of a block we already handled.
  if (!text.startsWith("---")) return null;
  const open = text.indexOf("\n");
  if (open < 0) return null;
  // A fence line is `---` and nothing else. `----` and `--- foo` are not
  // fences, and treating them as one would parse the rest of the file as
  // TypeScript.
  const close = /\n---[ \t]*(\r?\n|$)/.exec(text.slice(open));
  if (!close) return null;
  const from = open + 1;
  // `close.index` is the offset of the newline that ENDS the last content
  // line, measured from the opening newline, so it is already the exclusive
  // end of the block.
  const to = open + close.index;
  return to > from ? { from, to } : null;
}

const astroLanguage = htmlLanguage.configure({
  wrap: parseMixed((node: SyntaxNodeRef, input: Input) => {
    // The leading Text node, which is what the fenced block parses as. It has
    // to be that node and not the document: an overlay hung off the top node
    // is dropped, and one hung off a node it overruns is clipped anyway.
    if (node.name !== "Text" || node.from !== 0) return null;
    const range = frontmatterRange(input.read(0, Math.min(input.length, SCAN_LIMIT)));
    if (!range) return null;
    // Clipped to the node, because a `<` in the frontmatter (a generic, a
    // comparison) ends the Text node there and the HTML parser reads what
    // follows as a tag. The block keeps its TypeScript colouring up to that
    // point rather than losing all of it, which is the same trade every
    // HTML-hosted grammar makes and is why Astro's own tooling ships a real
    // parser instead.
    const from = Math.max(range.from, node.from);
    const to = Math.min(range.to, node.to);
    if (to <= from) return null;
    return { parser: typescriptLanguage.parser, overlay: [{ from, to }] };
  }),
}, "astro");

/** HTML's own support extensions come along: completion, tag closing and the
 *  auto-indent are all things an Astro template wants, and none of them care
 *  which parser produced the tree. */
export function astro(): LanguageSupport {
  return new LanguageSupport(astroLanguage, html().support);
}
