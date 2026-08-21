// Language id → CodeMirror extension. Split out of EditorPane so the editor
// and the diff pane share one mapping (they used to import `langForPath` from
// each other), and so the picker / breadcrumb can talk about languages without
// pulling every grammar in: this module is imported ONLY by the two lazily
// loaded panes, `lib/languages` is the one everything else touches.
//
// Two kinds of grammar live here. Lezer parsers (`@codemirror/lang-*`) build a
// real syntax tree — folding, indentation, nesting. Stream parsers are the old
// CodeMirror 5 tokenizers, wrapped by `StreamLanguage`: line-at-a-time, no
// tree, but they cover languages nobody has written a Lezer grammar for.

import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { elixir } from "codemirror-lang-elixir";
import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { proto3 } from "@/lib/protoMode";
import { makefile } from "@/lib/makeMode";
import { languageIdForPath, PLAIN_TEXT } from "@/lib/languages";

/** The grammar for a catalog id, or null for plain text / an unknown id. */
export function langForId(id: string | null | undefined): Extension | null {
  switch (id) {
    case "javascript":  return javascript({ jsx: true });
    case "typescript":  return javascript({ jsx: true, typescript: true });
    case "python":      return python();
    case "rust":        return rust();
    case "json":        return json();
    case "markdown":    return markdown();
    // HTML-ish template formats reuse the HTML grammar — component markup gets
    // tag highlighting; <script>/<style> blocks won't get deep JS/CSS parsing
    // but that's the same trade VS Code makes without dedicated extensions.
    case "html":        return html();
    case "css":         return css();
    case "yaml":        return yaml();
    case "sql":         return sql();
    case "xml":         return xml();
    case "cpp":         return cpp();
    case "go":          return go();
    case "java":        return java();
    case "elixir":      return elixir();
    case "protobuf":    return StreamLanguage.define(proto3);
    case "shell":       return StreamLanguage.define(shell);
    case "toml":        return StreamLanguage.define(toml);
    case "ruby":        return StreamLanguage.define(ruby);
    case "swift":       return StreamLanguage.define(swift);
    case "groovy":      return StreamLanguage.define(groovy);
    case "properties":  return StreamLanguage.define(properties);
    case "dockerfile":  return StreamLanguage.define(dockerFile);
    case "makefile":    return StreamLanguage.define(makefile);
    case PLAIN_TEXT:
    default:            return null;
  }
}

/** Grammar for a path, with no override in play. Kept for the diff pane,
 *  which has no user-settable syntax — a diff is of a file, so it follows
 *  that file's path. */
export function langForPath(path: string): Extension | null {
  return langForId(languageIdForPath(path));
}
