import { describe, expect, it } from "vitest";
import { languages as registry } from "@codemirror/language-data";
import {
  OVERLAY, isKnownLanguage, langForId, languageIdForPath, matchLanguage, pickerLanguages,
} from "./languageExts";
import { PLAIN_TEXT } from "./languages";

const id = languageIdForPath;

describe("languageIdForPath", () => {
  it("matches by extension", () => {
    expect(id("src/main.ts")).toBe("TypeScript");
    expect(id("build.js")).toBe("JavaScript");
    expect(id("main.rs")).toBe("Rust");
    expect(id("a/b/c.yml")).toBe("YAML");
    expect(id("icon.svg")).toBe("XML");
  });

  it("lights up languages nobody registered here", () => {
    // The whole point of the swap: none of these has an entry anywhere in
    // termic, and adding another needs no edit either.
    expect(id("index.php")).toBe("PHP");
    expect(id("init.lua")).toBe("Lua");
    expect(id("Main.hs")).toBe("Haskell");
    expect(id("script.ps1")).toBe("PowerShell");
    expect(id("Cargo.nix")).toBeNull(); // …and it still declines to guess
  });

  it("is case-insensitive about the extension", () => {
    // LanguageDescription.matchFilename compares the RAW extension, which is
    // why this module does its own matching. Do not swap it back.
    expect(id("README.MD")).toBe("Markdown");
    expect(id("MAIN.PY")).toBe("Python");
  });

  it("matches special filenames before extensions", () => {
    expect(id("Makefile")).toBe("Makefile");
    expect(id("GNUmakefile")).toBe("Makefile");
    expect(id("build/Makefile.local")).toBe("Makefile");
    expect(id("common.mk")).toBe("Makefile");
    // `Dockerfile.dev` is a Dockerfile, not a ".dev" file. The registry's own
    // pattern is anchored `/^Dockerfile$/`, so this is the overlay's.
    expect(id("Dockerfile")).toBe("Dockerfile");
    expect(id("docker/Dockerfile.dev")).toBe("Dockerfile");
    expect(id("justfile")).toBe("Shell");
    expect(id(".env")).toBe("Properties files");
    expect(id(".env.production")).toBe("Properties files");
  });

  it("keeps the shells and dialects the registry only lists as aliases", () => {
    expect(id("run.zsh")).toBe("Shell");
    expect(id("config.fish")).toBe("Shell");
    expect(id("nginx.conf")).toBe("Nginx"); // upstream's rule wins on its own turf
    expect(id("app.conf")).toBe("Properties files");
    expect(id("tasks.rake")).toBe("Ruby");
    expect(id("types.pyi")).toBe("Python");
    expect(id("post.mdx")).toBe("Markdown");
  });

  it("covers the JVM/Apple build files people actually open", () => {
    expect(id("StockApp.swift")).toBe("Swift");
    expect(id("Package.swift")).toBe("Swift");
    expect(id("app/build.gradle")).toBe("Groovy");
    // The Kotlin DSL flavour is Kotlin, and the registry knows the difference.
    expect(id("app/build.gradle.kts")).toBe("Kotlin");
    expect(id("Main.kt")).toBe("Kotlin");
    // …while gradle.properties is a properties file, not a build script.
    expect(id("gradle.properties")).toBe("Properties files");
  });

  it("keeps the grammars the registry cannot serve", () => {
    expect(id("service.proto")).toBe("ProtoBuf");
    expect(id("lib/mix.ex")).toBe("Elixir");
    expect(id("test/foo_test.exs")).toBe("Elixir");
  });

  it("gives component templates the HTML grammar", () => {
    expect(id("App.svelte")).toBe("HTML");
    expect(id("page.astro")).toBe("HTML");
    expect(id("row.hbs")).toBe("HTML");
    expect(id("App.vue")).toBe("Vue"); // upstream has a real one
  });

  it("gives up rather than guessing", () => {
    expect(id("notes")).toBeNull();
    expect(id("notes.txt")).toBeNull();
    expect(id("")).toBeNull();
    expect(id(undefined)).toBeNull();
  });
});

describe("the composed list", () => {
  it("has an overlay rule for every base still in the registry", () => {
    // A rule whose base language upstream renamed is silently dropped rather
    // than throwing at import (which would take the editor pane down with
    // it), so the count is what catches the rename.
    expect(OVERLAY).toHaveLength(8);
    for (const d of OVERLAY)
      expect(registry.some(r => r.name === d.name), `${d.name} is no longer upstream`).toBe(true);
  });

  it("replaces the registry's pre-proto3 ProtoBuf rather than shadowing it", () => {
    expect(pickerLanguages().filter(l => l.name === "ProtoBuf")).toHaveLength(1);
  });

  it("lists each language once, Plain Text first, the rest alphabetical", () => {
    const rows = pickerLanguages();
    expect(rows[0].name).toBe(PLAIN_TEXT);
    expect(new Set(rows.map(r => r.name)).size).toBe(rows.length);
    const rest = rows.slice(1).map(r => r.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
    // Aliases are what makes the fuzzy search find a language by a name
    // nobody displays: "ini" has to reach "Properties files".
    expect(rows.find(r => r.name === "Properties files")?.keywords).toContain("ini");
  });

  it("knows the names it hands out, and only those", () => {
    expect(isKnownLanguage("Rust")).toBe(true);
    expect(isKnownLanguage("Makefile")).toBe(true);
    expect(isKnownLanguage(PLAIN_TEXT)).toBe(true);
    expect(isKnownLanguage("markdown")).toBe(true); // legacy id, translated
    expect(isKnownLanguage("Cobol-74")).toBe(false);
  });
});

describe("langForId", () => {
  it("loads a grammar for a name", async () => {
    expect(await langForId("JSON")).not.toBeNull();
    expect(await langForId("Makefile")).not.toBeNull();
    expect(await langForId("markdown")).not.toBeNull(); // legacy id, translated
  });

  it("returns null for plain text, nothing, and an unknown name", async () => {
    expect(await langForId(PLAIN_TEXT)).toBeNull();
    expect(await langForId(null)).toBeNull();
    expect(await langForId("")).toBeNull();
    // A pick persisted by a build that knew a language this one does not must
    // leave the buffer unhighlighted, not fail the file open.
    expect(await langForId("Cobol-74")).toBeNull();
  });
});

describe("matchLanguage", () => {
  it("returns the description, so callers can load it once", async () => {
    const desc = matchLanguage("src/App.tsx");
    expect(desc?.name).toBe("TSX");
    expect(await desc!.load()).toBeTruthy();
  });
});
