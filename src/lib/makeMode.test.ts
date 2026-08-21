import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";
import { makefile } from "./makeMode";

/** Run the stream parser over a document the way StreamLanguage does, one
 *  line at a time, and return `[text, tag]` for every token it emits. */
function tokenize(doc: string): Array<[string, string | null]> {
  const state = makefile.startState!(2);
  const out: Array<[string, string | null]> = [];
  for (const line of doc.split("\n")) {
    const stream = new StringStream(line, 2, 2);
    if (!line) { makefile.blankLine?.(state, 2); continue; }
    let guard = 0;
    while (!stream.eol()) {
      const before = stream.pos;
      const tag = makefile.token(stream, state);
      // The parser must always advance — StreamLanguage throws otherwise, and
      // a stall here would hang the editor on the offending file.
      expect(stream.pos, `stalled at ${JSON.stringify(line.slice(before))}`).toBeGreaterThan(before);
      out.push([line.slice(before, stream.pos), tag]);
      stream.start = stream.pos;
      if (++guard > 500) throw new Error("runaway");
    }
  }
  return out;
}

/** The tag the parser gave the first occurrence of `text`. */
function tagOf(doc: string, text: string): string | null | undefined {
  return tokenize(doc).find(([t]) => t.trim() === text)?.[1];
}

const SAMPLE = [
  "# Build the app",
  "CARGO := cargo",
  "SRC = $(wildcard src/*.rs)",
  "",
  ".PHONY: build test",
  "",
  "build: $(SRC)",
  "\t@$(CARGO) build --release  # quiet",
  "\techo \"done\"",
  "",
  "test:",
  "\t$(CARGO) test \\",
  "\t  --all-features",
  "",
  "ifeq ($(OS),Darwin)",
  "  EXTRA = -framework Cocoa",
  "endif",
].join("\n");

describe("makefile mode", () => {
  it("tokenizes a real Makefile without stalling", () => {
    expect(tokenize(SAMPLE).length).toBeGreaterThan(20);
  });

  it("highlights comments, targets and assignments", () => {
    expect(tagOf(SAMPLE, "# Build the app")).toBe("comment");
    expect(tagOf(SAMPLE, "CARGO")).toBe("variableName.definition");
    expect(tagOf(SAMPLE, ":=")).toBe("operator");
    // In SAMPLE `build` first appears as a PREREQUISITE of .PHONY, which is
    // not a target definition — check the rule that defines it.
    expect(tagOf("build: $(SRC)\n", "build")).toBe("def");
    expect(tagOf(SAMPLE, ".PHONY")).toBe("keyword");
    expect(tagOf(SAMPLE, "ifeq")).toBe("keyword");
    expect(tagOf(SAMPLE, "endif")).toBe("keyword");
  });

  it("highlights expansions and built-in functions", () => {
    // The whole `$(wildcard` opener is one token: the `$(` belongs with the
    // function name, not with the argument that follows it.
    expect(tagOf(SAMPLE, "$(wildcard")).toBe("variableName.standard");
    expect(tagOf("x = $(NOTAFUNCTION)\n", "$(NOTAFUNCTION")).toBe("variableName");
    expect(tagOf("build:\n\tcc $< -o $@\n", "$<")).toBe("variableName.special");
    // `$$` is a literal dollar handed to the shell, not an expansion.
    expect(tagOf("run:\n\techo $$HOME\n", "$$")).toBe("operator");
  });

  it("treats a tab-indented line as a recipe, not as make syntax", () => {
    // `echo "done"` inside a recipe is shell: the word must NOT be tagged as
    // a target the way `build:` above is.
    const toks = tokenize("build:\n\techo \"done\"\n");
    expect(toks.find(([t]) => t.trim() === "echo")?.[1]).toBeNull();
    expect(toks.find(([t]) => t === '"done"')?.[1]).toBe("string");
    // The recipe prefix @ / - / + is syntax, and only at the start.
    expect(tagOf("build:\n\t@cc main.c\n", "@")).toBe("operator");
  });

  it("keeps a backslash continuation inside the recipe", () => {
    // The second line has no leading tab of its own in spirit — it continues
    // the recipe, so `--all-features` must stay shell text rather than being
    // read as a target list.
    const toks = tokenize("test:\n\t$(CARGO) test \\\n\t  --all-features\n");
    expect(toks.find(([t]) => t.trim() === "--all-features")?.[1]).toBeNull();
    // …and specifically not chopped into an ignore-errors `-` prefix.
    expect(toks.some(([t, tag]) => t === "-" && tag === "operator")).toBe(false);
  });

  it("does not mistake := for a target's colon", () => {
    expect(tagOf("CFLAGS := -O2\n", "CFLAGS")).toBe("variableName.definition");
    expect(tokenize("CFLAGS := -O2\n").some(([, tag]) => tag === "def")).toBe(false);
  });

  it("survives pathological input", () => {
    for (const doc of ["", "\n\n\n", ":", "\t", "$", "$(", "${", "#", "\\", "a:b:c:=1"])
      expect(() => tokenize(doc)).not.toThrow();
  });
});
