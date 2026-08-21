import { describe, expect, it } from "vitest";
import {
  MARKDOWN, PLAIN_TEXT, effectiveLanguageId, languageLabel, normalizeLanguageId,
} from "./languages";

describe("effectiveLanguageId", () => {
  it("prefers a manual pick over the automatic one", () => {
    expect(effectiveLanguageId({ path: "a.json", syntax: "YAML", syntaxAuto: "Python" })).toBe("YAML");
    // Including over the path, which is the whole point of Set syntax.
    expect(effectiveLanguageId({ path: "a.ts", syntax: PLAIN_TEXT })).toBe(PLAIN_TEXT);
  });

  it("falls back to the automatic answer, then plain text", () => {
    expect(effectiveLanguageId({ path: "a.py", syntaxAuto: "Python" })).toBe("Python");
    expect(effectiveLanguageId({ path: "notes", syntaxAuto: "JSON" })).toBe("JSON");
    expect(effectiveLanguageId({ path: "notes" })).toBe(PLAIN_TEXT);
    expect(effectiveLanguageId(null)).toBe(PLAIN_TEXT);
  });

  it("does NOT read the path itself", () => {
    // The registry lives in the lazy editor chunk, so path resolution happens
    // in the pane and arrives here as `syntaxAuto`. A tab the pane has not
    // resolved yet reads as plain text, however obvious its extension looks.
    expect(effectiveLanguageId({ path: "main.rs" })).toBe(PLAIN_TEXT);
  });
});

describe("normalizeLanguageId", () => {
  it("translates ids persisted before the registry swap", () => {
    // Only a scratchpad's pick is persisted (GH #244), so this is the one
    // path by which an old id can still reach a running build.
    expect(normalizeLanguageId("json")).toBe("JSON");
    expect(normalizeLanguageId("properties")).toBe("Properties files");
    expect(normalizeLanguageId("cpp")).toBe("C++");
    expect(normalizeLanguageId("protobuf")).toBe("ProtoBuf");
    expect(normalizeLanguageId("text")).toBe(PLAIN_TEXT);
    expect(normalizeLanguageId("markdown")).toBe(MARKDOWN);
  });

  it("leaves registry names alone", () => {
    for (const name of ["JSON", "TypeScript", "Properties files", PLAIN_TEXT, "Zig"])
      expect(normalizeLanguageId(name)).toBe(name);
  });

  it("passes an unrecognised id through untouched", () => {
    expect(normalizeLanguageId("cobol-74")).toBe("cobol-74");
  });

  it("survives a legacy id on the tab itself", () => {
    expect(effectiveLanguageId({ syntax: "markdown" })).toBe(MARKDOWN);
    expect(effectiveLanguageId({ syntaxAuto: "shell" })).toBe("Shell");
  });
});

describe("languageLabel", () => {
  it("uses the name as the label", () => {
    expect(languageLabel("Makefile")).toBe("Makefile");
    expect(languageLabel(null)).toBe(PLAIN_TEXT);
    expect(languageLabel(undefined)).toBe(PLAIN_TEXT);
    expect(languageLabel("makefile")).toBe("Makefile");
  });

  it("renders a name the registry no longer has verbatim", () => {
    // A pick persisted by a build whose registry had an entry this one
    // dropped must not render as blank.
    expect(languageLabel("Cobol")).toBe("Cobol");
  });
});
