import { describe, expect, it } from "vitest";
import { detectSyntaxFromContent } from "./detectSyntax";
import { isKnownLanguage } from "./languages";

const detect = detectSyntaxFromContent;

describe("detectSyntaxFromContent", () => {
  it("only ever returns ids the catalog knows", () => {
    const samples = [
      "#!/bin/bash\necho hi\n", "{\"a\":1}", "FROM node:20\nRUN npm i\n",
      "SELECT * FROM users;", "# Title\n\n- one\n- two\n",
    ];
    for (const s of samples) {
      const id = detect(s);
      expect(id).not.toBeNull();
      expect(isKnownLanguage(id!), `${id} is not in the catalog`).toBe(true);
    }
  });

  it("reads shebangs", () => {
    expect(detect("#!/bin/bash\necho hi\n")).toBe("shell");
    expect(detect("#!/usr/bin/env zsh\n")).toBe("shell");
    expect(detect("#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
    expect(detect("#!/usr/bin/env node\n")).toBe("javascript");
    expect(detect("#!/usr/bin/env ruby\n")).toBe("ruby");
    // Unknown interpreter still means "a script".
    expect(detect("#!/usr/bin/env whatever\n")).toBe("shell");
  });

  it("reads markup declarations", () => {
    expect(detect('<?xml version="1.0"?>\n<a/>')).toBe("xml");
    expect(detect("<!DOCTYPE html>\n<html></html>")).toBe("html");
    expect(detect('<svg viewBox="0 0 1 1"></svg>')).toBe("xml");
  });

  it("confirms JSON by parsing it, not by the first brace", () => {
    expect(detect('{"name": "termic", "n": [1, 2]}')).toBe("json");
    expect(detect("[1, 2, 3]")).toBe("json");
    // A brace that opens something else must not be called JSON.
    expect(detect("{ this is not json at all")).not.toBe("json");
  });

  it("tells a Makefile from YAML", () => {
    expect(detect("build:\n\tcargo build --release\n")).toBe("makefile");
    expect(detect(".PHONY: all\nall: build\n")).toBe("makefile");
    expect(detect("name: ci\non:\n  push:\n    branches: [main]\n")).toBe("yaml");
    // A YAML document marker is decisive on its own.
    expect(detect("---\nfoo: bar\n")).toBe("yaml");
  });

  it("needs more than the word FROM for a Dockerfile", () => {
    expect(detect("FROM rust:1.80 AS build\nRUN cargo build\n")).toBe("dockerfile");
    expect(detect("Copied FROM the other document, verbatim.\n")).not.toBe("dockerfile");
  });

  it("tells TOML from INI by its values", () => {
    expect(detect('[package]\nname = "termic"\nversion = "0.1.0"\n')).toBe("toml");
    expect(detect("[core]\nrepositoryformatversion\n\tbare\n")).toBe("properties");
  });

  it("recognises code by declarations", () => {
    expect(detect("package main\n\nfunc main() {}\n")).toBe("go");
    expect(detect("use std::fs;\n\nfn main() {\n}\n")).toBe("rust");
    expect(detect("from os import path\n\nx = 1\n")).toBe("python");
    expect(detect("interface Foo {\n  a: string\n}\n")).toBe("typescript");
    expect(detect('import { x } from "./x";\n')).toBe("javascript");
    expect(detect("SELECT id, name\nFROM users\nWHERE id = 1;\n")).toBe("sql");
  });

  it("wants two markdown signals, not one", () => {
    expect(detect("# Heading\n\n- a bullet\n- another\n")).toBe("markdown");
    // One stray dash list in a note is not a markdown document.
    expect(detect("shopping\n- milk\n")).toBeNull();
  });

  it("says nothing when it does not know", () => {
    expect(detect("")).toBeNull();
    expect(detect("   \n\n")).toBeNull();
    expect(detect("just some prose about the weather today\n")).toBeNull();
  });

  it("does not choke on a large buffer", () => {
    // Only the head is examined, and the JSON probe is skipped above its cap,
    // so a multi-megabyte file must still return promptly.
    const big = "x".repeat(3_000_000);
    const started = performance.now();
    expect(detect(`{${big}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });
});
