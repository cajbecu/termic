import { describe, expect, it } from "vitest";
import {
  LANGUAGES, PLAIN_TEXT, effectiveLanguageId, isKnownLanguage,
  languageIdForPath, languageLabel,
} from "./languages";

describe("language catalog", () => {
  it("has unique ids and labels", () => {
    const ids = LANGUAGES.map(l => l.id);
    const labels = LANGUAGES.map(l => l.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never claims the same extension twice", () => {
    // Two entries owning one extension makes `languageIdForPath` depend on
    // array order, which is not something a catalog should encode.
    const seen = new Map<string, string>();
    for (const lang of LANGUAGES) {
      for (const ext of lang.exts ?? []) {
        expect(seen.get(ext), `.${ext} claimed by both ${seen.get(ext)} and ${lang.id}`).toBeUndefined();
        seen.set(ext, lang.id);
      }
    }
  });

  it("keeps extensions lower-case and dotless", () => {
    for (const lang of LANGUAGES)
      for (const ext of lang.exts ?? [])
        expect(ext).toBe(ext.toLowerCase().replace(/^\./, ""));
  });
});

describe("languageIdForPath", () => {
  it("matches by extension", () => {
    expect(languageIdForPath("src/main.ts")).toBe("typescript");
    expect(languageIdForPath("src/app.tsx")).toBe("typescript");
    expect(languageIdForPath("build.js")).toBe("javascript");
    expect(languageIdForPath("main.rs")).toBe("rust");
    expect(languageIdForPath("a/b/c.yml")).toBe("yaml");
  });

  it("covers the JVM/Apple build files people actually open", () => {
    expect(languageIdForPath("StockApp.swift")).toBe("swift");
    expect(languageIdForPath("Package.swift")).toBe("swift");
    expect(languageIdForPath("app/build.gradle")).toBe("groovy");
    expect(languageIdForPath("settings.gradle")).toBe("groovy");
    // The Kotlin DSL flavour is Kotlin, so it rides the Java grammar.
    expect(languageIdForPath("app/build.gradle.kts")).toBe("java");
    expect(languageIdForPath("Main.kt")).toBe("java");
    // …while gradle.properties is a properties file, not a build script.
    expect(languageIdForPath("gradle.properties")).toBe("properties");
  });

  it("is case-insensitive about the extension", () => {
    expect(languageIdForPath("README.MD")).toBe("markdown");
  });

  it("matches special filenames before extensions", () => {
    expect(languageIdForPath("Makefile")).toBe("makefile");
    expect(languageIdForPath("GNUmakefile")).toBe("makefile");
    expect(languageIdForPath("build/Makefile.local")).toBe("makefile");
    expect(languageIdForPath("common.mk")).toBe("makefile");
    // `Dockerfile.dev` is a Dockerfile, not a ".dev" file.
    expect(languageIdForPath("Dockerfile.dev")).toBe("dockerfile");
    expect(languageIdForPath("justfile")).toBe("shell");
    expect(languageIdForPath(".env.production")).toBe("properties");
  });

  it("gives up rather than guessing", () => {
    expect(languageIdForPath("notes")).toBeNull();
    expect(languageIdForPath("notes.txt")).toBeNull();
    expect(languageIdForPath("")).toBeNull();
    expect(languageIdForPath(undefined)).toBeNull();
  });
});

describe("effectiveLanguageId", () => {
  it("prefers a manual pick over everything", () => {
    expect(effectiveLanguageId({ path: "a.json", syntax: "yaml", syntaxAuto: "python" })).toBe("yaml");
    // Including over the path, which is the whole point of Set syntax.
    expect(effectiveLanguageId({ path: "a.ts", syntax: PLAIN_TEXT })).toBe(PLAIN_TEXT);
  });

  it("falls back path → sniff → plain text", () => {
    expect(effectiveLanguageId({ path: "a.py", syntaxAuto: "json" })).toBe("python");
    expect(effectiveLanguageId({ path: "notes", syntaxAuto: "json" })).toBe("json");
    expect(effectiveLanguageId({ path: "notes" })).toBe(PLAIN_TEXT);
    expect(effectiveLanguageId(null)).toBe(PLAIN_TEXT);
  });
});

describe("languageLabel", () => {
  it("labels known ids and survives unknown ones", () => {
    expect(languageLabel("makefile")).toBe("Makefile");
    expect(languageLabel(null)).toBe("Plain Text");
    // An override persisted by a build whose catalog had an entry this one
    // dropped must not render as blank.
    expect(languageLabel("cobol")).toBe("cobol");
    expect(isKnownLanguage("cobol")).toBe(false);
    expect(isKnownLanguage("rust")).toBe(true);
  });
});
