// Content-based syntax detection, for buffers whose PATH says nothing: a file
// with no extension, a `.txt` note that is really JSON, a pasted log. Used
// only as the last fallback — `lib/languages` precedence is manual pick >
// path > this.
//
// Deliberately a set of cheap, ordered, high-confidence signals rather than a
// classifier. A wrong guess is worse than no guess (the user sees the wrong
// colours and has to go correct them), so every rule here wants a marker that
// is close to unambiguous, and anything vaguer returns null and stays plain.

/** Only the head of the buffer is examined — the giveaways (shebang, `FROM`,
 *  a JSON brace, frontmatter) all live near the top, and this runs on files up
 *  to the 2 MB read cap. */
const HEAD_BYTES = 8_000;
/** Above this, skip the JSON.parse probe: the brace test is already a strong
 *  signal and parsing megabytes to confirm it is not worth the main-thread
 *  pause. */
const JSON_PARSE_CAP = 512_000;

const SHEBANGS: Array<[RegExp, string]> = [
  [/\b(bash|sh|zsh|fish|dash|ksh)\b/, "shell"],
  [/\bpython[\d.]*\b/, "python"],
  [/\b(ruby|jruby)\b/, "ruby"],
  [/\bnode\b/, "javascript"],
  [/\bdeno\b/, "typescript"],
  [/\bmake\b/, "makefile"],
];

/** A language id from `lib/languages`, or null when nothing is confident. */
export function detectSyntaxFromContent(text: string): string | null {
  if (!text) return null;
  const head = text.slice(0, HEAD_BYTES);
  const trimmed = head.trimStart();
  if (!trimmed) return null;

  // 1. Shebang — the least ambiguous marker there is.
  if (trimmed.startsWith("#!")) {
    const line = trimmed.slice(0, trimmed.indexOf("\n") + 1 || undefined);
    for (const [re, id] of SHEBANGS) if (re.test(line)) return id;
    return "shell";
  }

  // 2. Markup with a declaration.
  if (/^<\?xml\b/i.test(trimmed)) return "xml";
  if (/^<!doctype\s+html\b/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return "html";
  if (/^<svg[\s>]/i.test(trimmed)) return "xml";

  // 3. JSON — brace/bracket first (cheap), then an actual parse of the WHOLE
  //    text, since a truncated head never parses.
  if (/^[{[]/.test(trimmed) && text.length <= JSON_PARSE_CAP) {
    try { JSON.parse(text); return "json"; } catch { /* not JSON, keep going */ }
  }

  // 4. Makefile before YAML: `target:` and `key:` look alike, and only make
  //    has tab-indented recipes under them.
  if (/^\.PHONY\s*:/m.test(head)
      || /^[A-Za-z0-9_.$(){}\/%-]+\s*:[^=\n]*\n\t/m.test(head)
      || (/^[A-Z_][A-Z0-9_]*\s*(:=|\?=|\+=)/m.test(head) && /^\t/m.test(head)))
    return "makefile";

  // 5. Dockerfile: FROM plus at least one other instruction, so a stray
  //    "FROM" in prose doesn't qualify.
  if (/^\s*FROM\s+\S+/im.test(head)
      && /^\s*(RUN|CMD|COPY|ADD|ENTRYPOINT|WORKDIR|ENV|EXPOSE)\s+/im.test(head))
    return "dockerfile";

  // 6. TOML before INI: both use [sections], only TOML uses `key = value`
  //    with quoted strings and dotted tables.
  if (/^\[[\w.$-]+\]\s*$/m.test(head)) {
    return /^\s*[\w.-]+\s*=\s*(["'[{]|\d)/m.test(head) ? "toml" : "properties";
  }

  // 7. YAML: a document marker, or several `key: value` lines with no braces
  //    (which would make it JSON-ish) and no tabs (illegal in YAML).
  if (/^---\s*$/m.test(trimmed.slice(0, 8))) return "yaml";
  if (!/^\t/m.test(head) && (head.match(/^[ ]*[\w.-]+:(\s|$)/gm)?.length ?? 0) >= 2
      && !/[{};]\s*$/m.test(head))
    return "yaml";

  // 8. Code, by declaration keywords that are rare as prose.
  if (/^package\s+\w+/m.test(head) && /\bfunc\s+\w*\s*\(/.test(head)) return "go";
  if (/^\s*(use\s+std::|fn\s+main\s*\(|impl\s+\w+|let\s+mut\s)/m.test(head)) return "rust";
  if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(head) || /^\s*from\s+[\w.]+\s+import\s/m.test(head))
    return "python";
  if (/^\s*(interface|type)\s+\w+\s*[={]/m.test(head) || /:\s*(string|number|boolean)\b/.test(head))
    return "typescript";
  if (/^\s*(import\s.+from\s|export\s+(default|const|function|class)\s|const\s+\w+\s*=\s*(\(|function))/m.test(head))
    return "javascript";
  if (/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW))\b/im.test(head))
    return "sql";

  // 9. Markdown last: its markers (headings, fences, lists) also appear in
  //    plain prose notes, so only take it when there are two of them.
  const md = [/^#{1,6}\s+\S/m, /^```/m, /^\s*[-*+]\s+\S/m, /^\s*\d+\.\s+\S/m, /\[[^\]]+\]\([^)]+\)/]
    .filter(re => re.test(head)).length;
  if (md >= 2) return "markdown";

  return null;
}
