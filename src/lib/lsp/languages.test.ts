import { describe, it, expect } from "vitest";
import { SERVERS, languageName, lspLanguageId, lspServerFor } from "./languages";

// The ids CodeMirror's registry uses are NOT the LSP spec's, and a server told
// the wrong one answers with nothing (or, worse, with a different language's
// idea of the file). This is the translation, and it is the only place that
// knows the two vocabularies differ.

describe("registry name → LSP languageId", () => {
  it("translates the names that differ", () => {
    expect(lspLanguageId("Shell")).toBe("shellscript");
    expect(lspLanguageId("Properties files")).toBe("ini");
    expect(lspLanguageId("C++")).toBe("cpp");
    expect(lspLanguageId("TSX")).toBe("typescriptreact");
  });

  it("lower-cases the ones that do not", () => {
    expect(lspLanguageId("Python")).toBe("python");
    expect(lspLanguageId("Rust")).toBe("rust");
  });

  it("has nothing to say about a buffer with no language", () => {
    // A scratchpad reaches here as Plain Text and must resolve to no server
    // rather than to a server for "plain text".
    expect(lspServerFor("Plain Text")).toBeNull();
    expect(lspLanguageId(null)).toBeNull();
    expect(lspServerFor(undefined)).toBeNull();
  });
});

describe("which server answers", () => {
  it("routes the whole TypeScript family to one server", () => {
    // One server, four languageIds: TSX and JS are not separate servers, and
    // treating them as such would spawn three indexes of the same project.
    for (const name of ["TypeScript", "TSX", "JavaScript", "JSX"]) {
      expect(lspServerFor(name)).toBe("typescript");
    }
  });

  it("names a server for the languages the host can resolve", () => {
    expect(lspServerFor("Python")).toBe("python");
    expect(lspServerFor("Rust")).toBe("rust");
    expect(lspServerFor("Go")).toBe("go");
  });

  it("returns null for a language nothing is wired for", () => {
    // Markdown and JSON are deliberately not served: CodeMirror already wins
    // in-process, and a subprocess to report a misspelled JSON key is a bad
    // trade. The UI must read that as an absence, not a broken toggle.
    expect(lspServerFor("Markdown")).toBeNull();
    expect(lspServerFor("JSON")).toBeNull();
    expect(lspServerFor("Makefile")).toBeNull();
  });
});

describe("the C family, Swift and Ruby", () => {
  it("routes every C-family buffer to the one server that serves them", () => {
    // clangd is C, C++ AND Objective-C. Three server ids would mean three
    // grants and three processes for one binary.
    expect(lspServerFor("C")).toBe("cpp");
    expect(lspServerFor("C++")).toBe("cpp");
    expect(lspServerFor("Objective-C")).toBe("cpp");
    expect(lspServerFor("Swift")).toBe("swift");
    expect(lspServerFor("Ruby")).toBe("ruby");
  });

  it("sends the spec's language id, not our registry name", () => {
    expect(lspLanguageId("C++")).toBe("cpp");
    expect(lspLanguageId("Objective-C")).toBe("objective-c");
    expect(lspLanguageId("Swift")).toBe("swift");
  });

  it("names them the way a person does", () => {
    // The id is not a name: "Turn on code intelligence for cpp" was the bug
    // this map exists to prevent.
    expect(languageName("cpp")).toBe("C and C++");
    expect(languageName("swift")).toBe("Swift");
    expect(languageName("ruby")).toBe("Ruby");
  });

  it("lists every server exactly once", () => {
    // SERVERS is derived from the routing map, where four ids share "cpp".
    expect(SERVERS).toEqual([...new Set(SERVERS)]);
    expect(SERVERS).toContain("cpp");
    expect(SERVERS).toContain("swift");
    expect(SERVERS).toContain("ruby");
    // Still a language nothing serves, which the UI must show as an absence.
    expect(lspServerFor("Elixir")).toBeNull();
  });
});
