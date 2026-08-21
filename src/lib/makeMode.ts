import type { StreamParser } from "@codemirror/language";

// `@codemirror/legacy-modes` ships ~150 grammars and a Makefile is not one of
// them, which is why `langForPath` used to give up on the single file every
// repo in termic has. Hand-rolled like lib/protoMode.ts.
//
// The one thing that makes a Makefile different from a config file is that a
// TAB at the start of a line is syntax: it opens a recipe, where the rest of
// the line is shell rather than make. We track exactly that (plus backslash
// continuations, which keep the recipe open across lines) and otherwise
// highlight targets, assignments, directives and `$(...)` expansions.

/** GNU make's built-in functions, highlighted inside `$(...)`. */
const FUNCTIONS = new Set([
  "subst", "patsubst", "strip", "findstring", "filter", "filter-out", "sort",
  "word", "wordlist", "words", "firstword", "lastword", "dir", "notdir",
  "suffix", "basename", "addsuffix", "addprefix", "join", "wildcard", "realpath",
  "abspath", "if", "or", "and", "foreach", "file", "call", "value", "eval",
  "origin", "flavor", "shell", "error", "warning", "info", "guile",
]);

/** Line-leading words that are make syntax rather than a target. */
const DIRECTIVES = new Set([
  "include", "-include", "sinclude", "ifeq", "ifneq", "ifdef", "ifndef", "else",
  "endif", "define", "endef", "export", "unexport", "override", "undefine",
  "vpath", "private", "load",
]);

interface MakeState {
  /** Inside a tab-indented recipe line (shell, not make). */
  recipe: boolean;
  /** Previous line ended in a backslash, so this line continues it. */
  continued: boolean;
  /** Nothing but whitespace consumed on this line yet. */
  lineStart: boolean;
}

export const makefile: StreamParser<MakeState> = {
  name: "makefile",
  languageData: {
    commentTokens: { line: "#" },
    // Recipes MUST be tabs. Indenting with spaces produces make's most
    // infamous error ("missing separator"), so the editor must not helpfully
    // insert two spaces here the way it does everywhere else.
    indentOnInput: /^\s*(else|endif|endef)$/,
  },
  startState: () => ({ recipe: false, continued: false, lineStart: true }),

  token(stream, state) {
    if (stream.sol()) {
      const continuing = state.continued;
      state.recipe = continuing || stream.peek() === "\t";
      state.continued = false;
      // A continuation is the SAME logical line, so nothing on it is
      // line-leading: `\\\n\t  --all-features` is an argument, not a fresh
      // recipe prefix, and `\\\n  foo` is not a fresh target list.
      state.lineStart = !continuing;
    }
    // A trailing backslash continues the logical line (recipe or not).
    if (stream.match(/^\\\s*$/)) { state.continued = true; return "operator"; }
    if (stream.eatSpace()) return null;

    // Comments run to end of line everywhere except inside a recipe, where a
    // `#` is the SHELL's comment — same rendering, so no need to distinguish.
    if (stream.peek() === "#") { stream.skipToEnd(); return "comment"; }

    // `$` expansions: automatic vars ($@ $< $^ …), `$$` (a literal dollar for
    // the shell), and `$(fn args)` / `${VAR}`.
    if (stream.eat("$")) {
      state.lineStart = false;
      if (stream.eat("$")) return "operator";
      if (stream.eat(/[@<^?*%+|]/)) return "variableName.special";
      const open = stream.eat(/[({]/);
      if (!open) { stream.eat(/\w/); return "variableName"; }
      // `$(shell …)` — the function name is highlighted, its arguments are
      // tokenized by the following passes (they can hold nested expansions).
      const fn = stream.match(/^[\w-]+(?=[\s)])/, false) as RegExpMatchArray | null;
      if (fn && FUNCTIONS.has(fn[0])) { stream.match(/^[\w-]+/); return "variableName.standard"; }
      stream.match(/^[^)}\s:]*/);
      return "variableName";
    }
    if (stream.eat(/[)}]/)) return "variableName";

    if (state.recipe) {
      // Recipe prefixes: @ silences the echo, - ignores failure, + forces it
      // under `make -n`. Only meaningful as the first character.
      // `-` is the ignore-errors prefix (`-rm -f x`); `--flag` is an argument
      // that merely starts with one.
      if (state.lineStart && stream.match(/^([@+]|-(?!-))/)) { state.lineStart = false; return "operator"; }
      state.lineStart = false;
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
      // Everything else is shell text. Advance to the next interesting char so
      // the tokenizer always makes progress.
      if (!stream.match(/^[^$#'"\\]+/)) stream.next();
      return null;
    }

    // ── make syntax (not a recipe) ────────────────────────────────────────
    if (state.lineStart) {
      const word = stream.match(/^-?[\w-]+(?=[\s(]|$)/, false) as RegExpMatchArray | null;
      if (word && DIRECTIVES.has(word[0])) {
        stream.match(/^-?[\w-]+/);
        state.lineStart = false;
        return "keyword";
      }
      // `.PHONY:` and friends. Special targets, not user targets.
      if (stream.match(/^\.[A-Z_]+(?=\s*:)/)) { state.lineStart = false; return "keyword"; }
      // A variable assignment: NAME followed by any of make's operators.
      if (stream.match(/^[\w.-]+(?=\s*(::=|:=|\?=|\+=|!=|=)(?!=))/)) {
        state.lineStart = false;
        return "variableName.definition";
      }
      // Otherwise a target list, up to the `:` that is not part of `:=`.
      if (stream.match(/^[^\s:=#]+(?=[^=]*:(?!=))/)) { state.lineStart = false; return "def"; }
    }
    state.lineStart = false;

    if (stream.match(/^(::=|:=|\?=|\+=|!=|[:=;|])/)) return "operator";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
    if (stream.match(/^[\w.\/-]+/)) return null;
    stream.next();
    return null;
  },
};
