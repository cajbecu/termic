import { describe, it, expect } from "vitest";
import { serverGuide, resolveServerSettings, deepMerge, parseRaw } from "./serverSettings";

// termic does not translate anyone's settings. It says which server runs,
// which file that server reads, and forwards a raw block untouched. These
// tests pin the two things that can silently go wrong: naming the server from
// its path, and sending a block down the channel that server does not read.

describe("which server, and how it is configured", () => {
  it("resolves the guide from the executable, not the language", () => {
    // The reason this is keyed by binary: one language, three servers, three
    // completely different answers to "where do settings live".
    expect(serverGuide("/Users/x/.local/bin/zuban")?.name).toBe("zuban");
    expect(serverGuide("/x/.venv/bin/ty")?.name).toBe("ty");
    expect(serverGuide("/x/.venv/bin/basedpyright-langserver")?.name).toBe("basedpyright");
  });

  it("knows tsc is the binary TypeScript 7 ships as", () => {
    // termic's own download unpacks to `package/lib/tsc`, and a card reading
    // "tsc" next to a tsconfig.json is the same server under its real name.
    expect(serverGuide("/x/servers/typescript/7.0.2/package/lib/tsc")?.name).toBe("TypeScript 7 (tsgo)");
  });

  it("says nothing rather than guessing about a server it does not know", () => {
    expect(serverGuide("/usr/bin/some-other-lsp")).toBeNull();
    expect(serverGuide(null)).toBeNull();
  });

  it("points every known server at a config file or admits it has none", () => {
    // gopls genuinely has no config file. Showing that is the point: a card
    // that implied one would send people looking for a file to create.
    expect(serverGuide("zuban")!.configFiles.map(f => f.path)).toContain("pyproject.toml");
    expect(serverGuide("gopls")!.configFiles.every(f => f.path !== "gopls.toml")).toBe(true);
    expect(serverGuide("gopls")!.summary).toContain("no configuration file");
    for (const exe of ["zuban", "ty", "basedpyright", "rust-analyzer", "gopls", "tsgo",
                       "clangd", "sourcekit-lsp", "ruby-lsp"]) {
      expect(serverGuide(exe)!.docs, exe).toMatch(/^https:\/\//);
      expect(serverGuide(exe)!.rawExample, exe).toContain("{");
    }
  });
});

describe("forwarding a raw block", () => {
  it("sends it where that server actually reads it", () => {
    // rust-analyzer takes its configuration at initialize; gopls only ever
    // pulls it. Down the wrong channel it is accepted and ignored, which is
    // the most expensive kind of wrong.
    expect(resolveServerSettings("rust-analyzer", { cargo: { features: "all" } }))
      .toEqual({ initializationOptions: { cargo: { features: "all" } }, settings: {} });
    expect(resolveServerSettings("gopls", { gopls: { buildFlags: ["-tags=x"] } }))
      .toEqual({ initializationOptions: {}, settings: { gopls: { buildFlags: ["-tags=x"] } } });
  });

  it("defaults an unknown server to the channel every server implements", () => {
    const out = resolveServerSettings("/usr/bin/mystery-lsp", { anything: 1 });
    expect(out.settings).toEqual({ anything: 1 });
    expect(out.initializationOptions).toEqual({});
  });

  it("does not touch the keys", () => {
    // No renaming, no validation: the server is the authority on its own
    // schema and says so in its own log.
    const weird = { "some.dotted.key": { nested: [1, 2] }, UPPER: null };
    expect(resolveServerSettings("zuban", weird).initializationOptions).toEqual(weird);
  });

  it("sends nothing for an empty or malformed block", () => {
    for (const bad of [undefined, null, 42, "nope", ["a"]]) {
      expect(resolveServerSettings("zuban", bad))
        .toEqual({ initializationOptions: {}, settings: {} });
    }
  });
});

describe("what the Advanced box accepts", () => {
  it("reports a parse error instead of throwing", () => {
    // Half-typed JSON is the normal state of a text field, not a failure.
    expect(parseRaw("{ \"a\":").error).toBeTruthy();
    expect(parseRaw("{ \"a\": 1 }")).toEqual({ value: { a: 1 }, error: null });
  });

  it("treats empty as no opinion", () => {
    expect(parseRaw("   ")).toEqual({ value: null, error: null });
  });

  it("insists on an object, because that is what a settings block is", () => {
    expect(parseRaw("[1,2]").error).toContain("JSON object");
    expect(parseRaw("\"hello\"").error).toContain("JSON object");
  });
});

describe("deepMerge", () => {
  it("replaces arrays instead of concatenating them", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("keeps branches the override does not mention", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({ a: { x: 1, y: 3 } });
  });
});

describe("the servers added after the first four", () => {
  it("resolves each one from the path it is spawned as", () => {
    expect(serverGuide("/usr/bin/clangd")?.name).toBe("clangd");
    expect(serverGuide("/usr/bin/sourcekit-lsp")?.name).toBe("sourcekit-lsp");
    expect(serverGuide("/opt/homebrew/lib/ruby/gems/4.0.0/bin/ruby-lsp")?.name).toBe("ruby-lsp");
    // A project's own binstub, which is what termic prefers for Ruby.
    expect(serverGuide("/repo/bin/ruby-lsp")?.name).toBe("ruby-lsp");
  });

  it("leads with the thing that makes each one answer badly", () => {
    // Each of these was observed, not imagined: clangd guesses flags with no
    // compilation database, sourcekit-lsp has no index until a build, and
    // ruby-lsp exits outright on an unlocked bundle.
    expect(serverGuide("clangd")!.summary).toContain("compile_commands.json");
    expect(serverGuide("sourcekit-lsp")!.summary).toContain("built");
    expect(serverGuide("ruby-lsp")!.summary).toContain("Gemfile.lock");
  });

  it("names how each one is told to ignore paths, in its own spelling", () => {
    expect(serverGuide("clangd")!.excludes).toContain("PathExclude");
    expect(serverGuide("ruby-lsp")!.excludes).toContain("excluded_patterns");
    // Saying it has none is information too, and better than inventing a key.
    expect(serverGuide("sourcekit-lsp")!.excludes).toContain("No exclude setting");
  });
});
