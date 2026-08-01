import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { proto3 } from "@/lib/protoMode";

// Tokenize one line, carrying `state` across calls the way StreamLanguage does.
function tokens(line: string, state = proto3.startState!(2)) {
  const stream = new StringStream(line, 2, 2);
  const out: Array<[string, string | null]> = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const tag = proto3.token(stream, state);
    if (stream.pos === stream.start) throw new Error("token consumed nothing");
    out.push([stream.current(), tag]);
  }
  return out;
}

const tagOf = (line: string, text: string) =>
  tokens(line).find(([t]) => t === text)?.[1];

describe("proto3 keywords", () => {
  it("tags the proto3 keywords the legacy mode misses", () => {
    for (const kw of ["oneof", "map", "extend", "stream", "true", "false"])
      expect(tagOf(`${kw} `, kw)).toBe("keyword");
  });

  it("does not tag identifiers that merely start with a keyword", () => {
    expect(tagOf("mapping = 1", "mapping")).toBe("variable");
    expect(tagOf("oneofFoo bar", "oneofFoo")).toBe("variable");
  });

  it("still delegates the legacy mode's own tokens", () => {
    expect(tagOf("message Foo {", "message")).toBe("keyword");
    expect(tagOf("message Foo {", "Foo")).toBe("variable");
    expect(tagOf('default = "hi"', '"hi"')).toBe("string");
    expect(tagOf("x = 42;", "42")).toBe("number");
    expect(tagOf("// note", "// note")).toBe("comment");
  });
});

describe("proto3 block comments", () => {
  it("tags a block comment that opens and closes on one line", () => {
    expect(tokens("/* hi */")).toEqual([["/* hi */", "comment"]]);
  });

  it("resumes code after a closed block comment", () => {
    expect(tagOf("/* hi */ message Foo", "message")).toBe("keyword");
  });

  it("carries an unterminated block comment across lines", () => {
    const state = proto3.startState!(2);
    expect(tokens("/* start", state)).toEqual([["/* start", "comment"]]);
    expect(state.block).toBe(true);

    expect(tokens("still inside", state)).toEqual([["still inside", "comment"]]);
    expect(state.block).toBe(true);

    expect(tokens("done */ message Foo", state)).toEqual([
      ["done */", "comment"],
      [" ", null],
      ["message", "keyword"],
      [" ", null],
      ["Foo", "variable"],
    ]);
    expect(state.block).toBe(false);
  });
});
