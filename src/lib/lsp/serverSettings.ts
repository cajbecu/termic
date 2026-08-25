// Configuring a language server, without termic inventing a dialect (GH #174).
//
// The tempting design is a settings screen of friendly toggles that termic
// translates into whatever each server understands. It was built and thrown
// away, for the reason that kills every mapping layer: zuban takes
// `typeCheckingMode` in `initializationOptions`, ty takes `ty.diagnosticMode`
// as a pulled setting, basedpyright takes `python.analysis.diagnosticMode`,
// and they do not even agree on how to spell the same VALUE
// (`open-files-only` against `openFilesOnly`). Three servers, one language,
// three dialects, all of them moving. A mapping table is a second, staler copy
// of five projects' documentation, and the day it drifts the app silently
// sends a key nobody reads.
//
// What a person actually needs is the truth, stated once, in their project's
// terms: **this is the server that runs, this is the file it reads, here are
// its docs.** Almost every server takes its real configuration from a file in
// the repo (`pyproject.toml`, `pyrightconfig.json`, `tsconfig.json`,
// `rust-analyzer.toml`), which is committed, team-shared, and works in every
// other editor those people use. Pointing at that file beats owning a copy of
// its schema, and it is the answer that stays true.
//
// The Advanced box is the exception, not the interface: some settings exist
// ONLY over LSP (gopls has no config file at all), so termic forwards a raw
// block verbatim into whichever channel that server reads. It is not
// validated, because the server is the authority on its own keys.

/** A file in the checkout that a server reads. */
export interface ConfigFile {
  /** Path relative to the checkout root. */
  path: string;
  /** The section inside it, when the file is shared with other tools. */
  section?: string;
  note?: string;
}

/** Everything the UI needs to say about one server, in one place. */
export interface ServerGuide {
  /** What a person calls it. */
  name: string;
  /** One sentence: what it is, and where its settings really come from. */
  summary: string;
  /** In the order the server looks for them. Empty when it has no config
   *  file at all, which is a fact worth showing rather than hiding. */
  configFiles: ConfigFile[];
  /** Environment variables it honours, for the cases a file cannot cover. */
  env: Array<{ name: string; note: string }>;
  /** How THIS server is told to ignore paths. Named rather than abstracted:
   *  every one of them spells it differently (a regex here, globs there, a
   *  `-prefixed` list somewhere else), and a termic-level pattern translated
   *  five ways would silently exclude the wrong thing the first time any of
   *  them changed. Naming the key is information; owning it is a liability. */
  excludes?: string;
  docs: string;
  /** Where a raw block has to go for THIS server: `initialize` time, or the
   *  `workspace/configuration` the server pulls. Getting this wrong means the
   *  settings are sent and ignored. */
  rawChannel: "init" | "settings";
  /** Shown in the empty Advanced box, so it is never a blank prompt. Real
   *  keys, from that server's own documentation. */
  rawExample: string;
}

/**
 * Keyed by the BINARY that runs, not by language: a Python checkout may be
 * zuban, ty or basedpyright, and the answer to "how do I configure this" is
 * completely different for each. `serverGuide` resolves the key from the path.
 */
const GUIDES: Record<string, ServerGuide> = {
  zuban: {
    name: "zuban",
    summary:
      "Reads mypy's own configuration, so a project already set up for mypy needs nothing new. It understands Django's ORM without stubs, which is why termic prefers it for Python when it is installed.",
    configFiles: [
      { path: "pyproject.toml", section: "[tool.zuban]", note: "zuban's own options" },
      { path: "pyproject.toml", section: "[tool.mypy]", note: "read verbatim, same as mypy" },
      { path: "mypy.ini" },
    ],
    env: [
      { name: "MYPYPATH", note: "extra search paths, mypy's spelling" },
      { name: "PYTHONPATH", note: "extra search paths" },
      { name: "ZUBAN_LOG", note: "`info` or `debug`, when you need to see why" },
    ],
    excludes: "`exclude` under `[tool.mypy]`, a regular expression. `exclude_gitignore = true` follows your .gitignore.",
    docs: "https://docs.zubanls.com/en/latest/usage.html",
    rawChannel: "init",
    rawExample: `{\n  "typeCheckingMode": "mypy",\n  "reportMissingTypeStubs": "information",\n  "reportUnknownVariableType": "information"\n}`,
  },
  ty: {
    name: "ty",
    summary:
      "Astral's checker, the fastest of the Python set. Correct on Django once django-stubs is installed.",
    configFiles: [
      { path: "pyproject.toml", section: "[tool.ty]" },
      { path: "ty.toml" },
    ],
    env: [],
    excludes: "`exclude` under `[tool.ty.src]`, glob patterns.",
    docs: "https://docs.astral.sh/ty/reference/editor-settings/",
    rawChannel: "settings",
    rawExample: `{\n  "ty": {\n    "diagnosticMode": "workspace"\n  }\n}`,
  },
  basedpyright: {
    name: "basedpyright",
    summary: "A fork of pyright with more checks on by default. Takes pyright's configuration.",
    configFiles: [
      { path: "pyproject.toml", section: "[tool.basedpyright]" },
      { path: "pyrightconfig.json" },
    ],
    env: [],
    excludes: "`exclude` in pyrightconfig.json or `[tool.basedpyright]`, glob patterns.",
    docs: "https://docs.basedpyright.com/latest/configuration/language-server-settings/",
    rawChannel: "settings",
    rawExample: `{\n  "python": {\n    "analysis": {\n      "typeCheckingMode": "standard",\n      "reportMissingTypeStubs": "information",\n      "reportUnknownVariableType": "information",\n      "extraPaths": ["./src"]\n    }\n  }\n}`,
  },
  pyright: {
    name: "pyright",
    summary: "Microsoft's Python checker.",
    configFiles: [
      { path: "pyproject.toml", section: "[tool.pyright]" },
      { path: "pyrightconfig.json" },
    ],
    env: [],
    docs: "https://microsoft.github.io/pyright/#/settings",
    rawChannel: "settings",
    rawExample: `{\n  "python": {\n    "analysis": {\n      "typeCheckingMode": "standard",\n      "reportMissingTypeStubs": "information",\n      "reportUnknownVariableType": "information"\n    }\n  }\n}`,
  },
  "rust-analyzer": {
    name: "rust-analyzer",
    summary:
      "Configured mostly through the editor rather than a file, though a `rust-analyzer.toml` in the workspace root covers a growing subset. What it can see is decided by Cargo: a file behind a feature that is off answers nothing at all.",
    configFiles: [
      { path: "rust-analyzer.toml", note: "workspace root, a subset of the options" },
      { path: "Cargo.toml", note: "features and workspace members decide what is analysed" },
    ],
    env: [
      { name: "RUSTUP_TOOLCHAIN", note: "which toolchain it builds against" },
      { name: "RA_LOG", note: "`rust_analyzer=info` to see the config it received" },
    ],
    excludes: "`files.excludeDirs`, a list of directories.",
    docs: "https://rust-analyzer.github.io/book/configuration.html",
    rawChannel: "init",
    rawExample: `{\n  "cargo": { "features": "all" },\n  "procMacro": { "enable": true }\n}`,
  },
  clangd: {
    name: "clangd",
    summary:
      "Reads your BUILD, not your source tree: a compile_commands.json tells it each file's include paths and flags, and without one it guesses and reports headers that exist as missing. CMake writes one with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON.",
    configFiles: [
      { path: "compile_commands.json", note: "the compilation database; symlink your build's copy here" },
      { path: ".clangd", note: "flags to add or remove, per path" },
      { path: ".clang-format", note: "used for formatting only" },
    ],
    env: [
      { name: "CPATH", note: "extra include directories, honoured by the compiler it drives" },
    ],
    excludes: "`If.PathExclude` in `.clangd`, a regex matched against the file path.",
    docs: "https://clangd.llvm.org/config",
    // clangd takes its options on the command line and from .clangd files;
    // the LSP settings block is small but real (fallbackFlags, compilationDatabasePath).
    rawChannel: "settings",
    rawExample: `{\n  "clangd": {\n    "fallbackFlags": ["-std=c++20", "-I/usr/local/include"]\n  }\n}`,
  },
  "sourcekit-lsp": {
    name: "sourcekit-lsp",
    summary:
      "Answers from the index the Swift compiler writes while building, so a package that has never been built answers about the open file and little else. Build it once and it knows the whole package.",
    configFiles: [
      { path: "Package.swift", note: "the package it serves; targets and dependencies come from here" },
      { path: ".sourcekit-lsp/config.json", note: "per-project server options" },
    ],
    env: [
      { name: "TOOLCHAINS", note: "pick a non-default Swift toolchain (e.g. `swift` for a snapshot)" },
    ],
    excludes: "No exclude setting. It serves what the package manifest declares.",
    docs: "https://github.com/swiftlang/sourcekit-lsp/blob/main/Documentation/Configuration%20File.md",
    rawChannel: "init",
    rawExample: `{\n  "swiftPM": { "configuration": "debug" }\n}`,
  },
  "ruby-lsp": {
    name: "ruby-lsp",
    summary:
      "Runs against the project's bundle, so its answers are about the gems this app actually loads. It refuses to start when a Gemfile has no Gemfile.lock: `bundle install` first.",
    configFiles: [
      { path: "Gemfile", note: "the bundle it runs against (a Gemfile.lock must exist)" },
      { path: ".index.yml", note: "which paths and gems are indexed" },
      { path: ".rubocop.yml", note: "used when the RuboCop add-on is enabled" },
    ],
    env: [
      { name: "BUNDLE_GEMFILE", note: "point it at a different Gemfile" },
      { name: "RUBY_LSP_BYPASS_TYPECHECKER", note: "ignore Sorbet/RBS when they confuse it" },
    ],
    excludes: "`excluded_patterns` in `.index.yml`, a list of globs.",
    docs: "https://shopify.github.io/ruby-lsp/configuration",
    rawChannel: "init",
    rawExample: `{\n  "formatter": "rubocop",\n  "enabledFeatures": { "diagnostics": false }\n}`,
  },
  gopls: {
    name: "gopls",
    summary:
      "Has no configuration file of its own: every setting comes from the editor, which is what the box below is for. Build tags and module layout come from the Go toolchain.",
    configFiles: [
      { path: "go.work", note: "which modules are in the workspace" },
    ],
    env: [
      { name: "GOFLAGS", note: "e.g. `-tags=integration`, so tagged files are analysed" },
      { name: "GOPRIVATE", note: "modules to fetch without the proxy" },
    ],
    excludes: "`directoryFilters`, e.g. `[\"-migrations\"]`, in the Advanced box below.",
    docs: "https://github.com/golang/tools/blob/master/gopls/doc/settings.md",
    rawChannel: "settings",
    rawExample: `{\n  "gopls": {\n    "buildFlags": ["-tags=integration"],\n    "analyses": { "unusedparams": true }\n  }\n}`,
  },
  tsgo: {
    name: "TypeScript 7 (tsgo)",
    summary:
      "Takes the project's own `tsconfig.json`, exactly like `tsc`. There is rarely anything to configure here that does not belong in that file.",
    configFiles: [
      { path: "tsconfig.json", note: "the real configuration, and the one your build already uses" },
    ],
    env: [],
    excludes: "`exclude` in tsconfig.json, glob patterns.",
    docs: "https://github.com/microsoft/typescript-go",
    rawChannel: "settings",
    rawExample: `{\n  "typescript": {\n    "preferences": { "includePackageJsonAutoImports": "auto" }\n  }\n}`,
  },
  "typescript-language-server": {
    name: "typescript-language-server",
    summary: "Takes the project's own `tsconfig.json`, plus editor preferences.",
    configFiles: [{ path: "tsconfig.json", note: "the real configuration" }],
    env: [],
    docs: "https://github.com/typescript-language-server/typescript-language-server#configuration",
    rawChannel: "settings",
    rawExample: `{\n  "typescript": {\n    "preferences": { "importModuleSpecifier": "relative" }\n  }\n}`,
  },
};

/** `tsc` is the binary TypeScript 7 ships as; it is tsgo. */
GUIDES.tsc = GUIDES.tsgo;
GUIDES["basedpyright-langserver"] = GUIDES.basedpyright;
GUIDES["pyright-langserver"] = GUIDES.pyright;

/** The guide for a resolved executable path, or null when termic has nothing
 *  to say about it (a server the user added themselves). */
export function serverGuide(exe: string | null | undefined): ServerGuide | null {
  const base = exe?.split("/").pop() ?? "";
  return GUIDES[base] ?? null;
}

/** Deep merge, `over` winning. Arrays REPLACE: every list a server takes
 *  (`extraPaths`, `buildFlags`, `features`) is one somebody will need to
 *  correct, and a list you cannot shorten is a list you cannot fix. */
export function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface ResolvedServerSettings {
  /** Merged into `initialize`. */
  initializationOptions: Record<string, unknown>;
  /** Answered whenever the server pulls `workspace/configuration`. */
  settings: Record<string, unknown>;
}

/**
 * Where the user's raw block goes for this server.
 *
 * Nothing is validated or renamed. The server is the authority on its own
 * keys, it says so in its own log when it disagrees, and a client-side
 * allowlist would only be a copy of a schema that changes every release.
 *
 * The channel is not a preference: rust-analyzer reads its configuration from
 * `initializationOptions`, gopls only ever pulls it, and sending a block down
 * the wrong one means it is accepted and ignored, which is the most expensive
 * kind of wrong. When termic does not know the server, settings is the safer
 * default: `workspace/configuration` is the channel every server implements,
 * and an unknown key there is ignored rather than fatal.
 */
export function resolveServerSettings(exe: string | null | undefined, raw?: unknown): ResolvedServerSettings {
  const out: ResolvedServerSettings = { initializationOptions: {}, settings: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const guide = serverGuide(exe);
  const block = raw as Record<string, unknown>;
  if (guide?.rawChannel === "init") out.initializationOptions = block;
  else out.settings = block;
  return out;
}

/** Parse what the user typed into the Advanced box. Returns the error string
 *  rather than throwing: the box shows it inline while they are still typing,
 *  and half-typed JSON is the normal state of a text field, not a failure. */
export function parseRaw(text: string): { value: Record<string, unknown> | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, error: "Needs to be a JSON object, like the example." };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (e) {
    return { value: null, error: (e as Error).message };
  }
}
