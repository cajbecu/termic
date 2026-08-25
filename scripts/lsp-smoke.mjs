#!/usr/bin/env node
// Do the real language servers still do what termic thinks they do?
//
// LOCAL ONLY, and deliberately not in CI: this starts the actual servers
// against the actual toolchains on this machine, which is the whole point and
// also exactly what a CI runner does not have. Nothing here gates a merge. Run
// it when a server is upgraded, before a release, or on a timer.
//
//   make lsp-smoke                 every language this machine can serve
//   make lsp-smoke LANG=python     just one
//   node scripts/lsp-smoke.mjs --record   refresh the symbol-search fixtures
//
// What it checks, per language, on a tiny fixture project in
// e2e/fixtures/lsp-projects:
//
//   resolve      termic's own resolution finds a server at all
//   hover        a known symbol answers with something
//   definition   a symbol USED in one file resolves to where it is DEFINED
//   symbols      workspace/symbol finds the definition of `Store`
//   diagnostics  a deliberately broken file reports at least one problem
//   undefined    that file's undefined name is named in a diagnostic
//
// `--record` writes the raw workspace/symbol answers to
// src/lib/lsp/__fixtures__/, which `symbolSearch.realservers.test.ts` runs the
// ranking pipeline over in the normal (offline) suite. That is the division of
// labour: this script proves the servers behave as documented, the unit test
// proves termic's rules still turn that into the right list.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projects = path.join(repoRoot, "e2e", "fixtures", "lsp-projects");
const fixtures = path.join(repoRoot, "src", "lib", "lsp", "__fixtures__");

const RECORD = process.argv.includes("--record");
const ONLY = process.env.LANG_ONLY || null;

/** Mirrors lsp_resolve_server in src-tauri/src/lib.rs. Kept in step by hand;
 *  the point of the `resolve` check is to notice when it is not. */
const onPath = (exe) => (process.env.PATH ?? "").split(":")
  .map(d => d && path.join(d, exe)).find(p => p && existsSync(p)) ?? null;

const installed = (rel) => {
  const p = path.join(process.env.HOME ?? "", "Library/Application Support/termic/servers", rel);
  return existsSync(p) ? p : null;
};

function resolveServer(lang, root) {
  const local = (rel) => (existsSync(path.join(root, rel)) ? path.join(root, rel) : null);
  switch (lang) {
    case "typescript": {
      const exe = local("node_modules/.bin/tsgo") ?? onPath("tsgo")
        ?? installed("typescript/7.0.2/package/lib/tsc");
      return exe ? [exe, ["--lsp", "--stdio"]] : null;
    }
    case "python": {
      const zb = local(".venv/bin/zuban") ?? onPath("zuban");
      if (zb) return [zb, ["server"]];
      const ty = local(".venv/bin/ty") ?? onPath("ty");
      if (ty) return [ty, ["server"]];
      const bp = onPath("basedpyright-langserver");
      return bp ? [bp, ["--stdio"]] : null;
    }
    case "rust": {
      const ra = onPath("rust-analyzer");
      return ra ? [ra, []] : null;
    }
    case "go": {
      const g = onPath("gopls") ?? (existsSync(`${process.env.HOME}/go/bin/gopls`)
        ? `${process.env.HOME}/go/bin/gopls` : null);
      return g ? [g, []] : null;
    }
    case "cpp": {
      const versioned = ["21", "20", "19", "18", "17", "16", "15", "14"];
      const exe = onPath("clangd") ?? versioned.map(v => onPath(`clangd-${v}`)).find(Boolean);
      return exe
        ? [exe, ["--background-index", "--background-index-priority=background"]]
        : null;
    }
    case "swift": {
      const exe = onPath("sourcekit-lsp");
      return exe ? [exe, []] : null;
    }
    case "ruby": {
      const exe = local("bin/ruby-lsp") ?? local(".bundle/bin/ruby-lsp") ?? onPath("ruby-lsp");
      return exe ? [exe, []] : null;
    }
    default: return null;
  }
}

/** What each language's fixture looks like, and what a correct answer is. */
const CASES = {
  typescript: {
    root: path.join(projects, "typescript"),
    languageId: "typescript",
    /** Where a symbol is USED, and the position of that use. */
    use: { file: "src/uses.ts", line: 3, col: 34, name: "Store" },
    /** The file the definition must land in. */
    definedIn: "src/models.ts",
    broken: "src/broken.ts",
    undefinedName: "thisNameDoesNotExist",
    symbolQuery: "Store",
  },
  python: {
    root: path.join(projects, "python"),
    languageId: "python",
    use: { file: "uses.py", line: 4, col: 23, name: "Store" },
    definedIn: "models.py",
    broken: "broken.py",
    undefinedName: "this_name_does_not_exist",
    symbolQuery: "Store",
  },
  rust: {
    root: path.join(projects, "rust"),
    languageId: "rust",
    use: { file: "src/lib.rs", line: 9, col: 32, name: "Store" },
    definedIn: "src/lib.rs",
    broken: null,        // rust-analyzer needs a cargo check cycle; too slow here
    undefinedName: null,
    symbolQuery: "Store",
  },
  go: {
    root: path.join(projects, "go"),
    languageId: "go",
    use: { file: "api/handlers.go", line: 5, col: 25, name: "Store" },
    definedIn: "stores/models.go",
    broken: null,
    undefinedName: null,
    symbolQuery: "Store",
  },
  cpp: {
    root: path.join(projects, "cpp"),
    languageId: "cpp",
    use: { file: "src/uses.cpp", line: 4, col: 28, name: "Store" },
    // The header, because that is where the struct is declared: clangd
    // answering the .cpp here would mean it had guessed rather than read the
    // compilation database.
    definedIn: "src/models.h",
    broken: null,        // needs the index warm; the definition check covers the pipe
    undefinedName: null,
    symbolQuery: "Store",
    // Written rather than committed: every path in it is absolute, so a
    // checked-in copy would be right on exactly one machine.
    prepare: (root) => {
      const entry = (file) => ({
        directory: root,
        command: `c++ -std=c++17 -I${path.join(root, "src")} -c ${path.join(root, file)}`,
        file: path.join(root, file),
      });
      writeFileSync(
        path.join(root, "compile_commands.json"),
        JSON.stringify([entry("src/models.cpp"), entry("src/uses.cpp")], null, 2) + "\n",
      );
    },
  },
  swift: {
    root: path.join(projects, "swift"),
    languageId: "swift",
    use: { file: "Sources/LspFixture/Uses.swift", line: 2, col: 31, name: "Store" },
    definedIn: "Sources/LspFixture/Models.swift",
    broken: null,
    undefinedName: null,
    symbolQuery: "Store",
    // sourcekit-lsp reads the index the compiler writes, so a package that has
    // never been built answers about the file in front of it and nothing else.
    // This is the same first-run cost a user pays, which is worth knowing.
    prepare: (root) => {
      if (existsSync(path.join(root, ".build"))) return;
      process.stdout.write("  building the Swift fixture once (index-while-building)…\n");
      spawnSync("swift", ["build"], { cwd: root, stdio: "ignore", timeout: 300_000 });
    },
  },
  ruby: {
    root: path.join(projects, "ruby"),
    languageId: "ruby",
    use: { file: "lib/uses.rb", line: 7, col: 3, name: "Store" },
    definedIn: "lib/models.rb",
    broken: null,
    undefinedName: null,
    symbolQuery: "Store",
    // ruby-lsp EXITS on a Gemfile with no Gemfile.lock rather than running
    // against an unlocked bundle, which from the outside is indistinguishable
    // from a server that failed to start. `lsp_offer` says so in the app; here
    // it just has to not happen.
    prepare: (root) => {
      if (existsSync(path.join(root, "Gemfile.lock"))) return;
      spawnSync("bundle", ["install"], { cwd: root, stdio: "ignore", timeout: 300_000 });
    },
  },
};

const uriFor = (p) => "file://" + p.split("/").map(seg =>
  encodeURIComponent(seg).replace(/%2F/g, "/")).join("/");

/** A minimal LSP client over stdio: framing, the server→client replies termic
 *  makes, and request/response by id. Mirrors the Rust host closely enough
 *  that a failure here means a real failure there. */
function connect(exe, args, root, languageId) {
  const env = { ...process.env };
  const venv = path.join(root, ".venv");
  if (languageId === "python" && existsSync(venv)) env.VIRTUAL_ENV = venv;
  const child = spawn(exe, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d.toString(); });

  const pending = new Map();
  let nextId = 1;
  let buf = Buffer.alloc(0);

  const send = (msg) => {
    const body = JSON.stringify(msg);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };

  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, headEnd).toString("ascii"));
      if (!m) { buf = buf.subarray(headEnd + 4); continue; }
      const len = Number(m[1]), start = headEnd + 4;
      if (buf.length < start + len) return;
      let msg;
      try { msg = JSON.parse(buf.subarray(start, start + len).toString("utf8")); }
      catch { msg = null; }
      buf = buf.subarray(start + len);
      if (!msg) continue;
      // A server→client REQUEST: answer it the way the Rust host does. One
      // entry per requested item (ty exits on the wrong arity), null for
      // everything else (an error reply kills pyright).
      if (msg.id !== undefined && msg.method) {
        let result = null;
        if (msg.method === "workspace/configuration") {
          const items = msg.params?.items ?? [{}];
          const py = path.join(root, ".venv/bin/python");
          result = items.map(it => {
            if (it?.section === "python" && existsSync(py)) return { pythonPath: py };
            return null;
          });
        }
        send({ jsonrpc: "2.0", id: msg.id, result });
        continue;
      }
      if (msg.method === "textDocument/publishDiagnostics") {
        pushed.push(msg.params);
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.error ? { __error: msg.error } : msg.result);
      }
    }
  });

  const pushed = [];
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  return { child, request, notify, pushed, stderr: () => stderr };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function runLanguage(lang, cfg) {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });

  const resolved = resolveServer(lang, cfg.root);
  if (!resolved) {
    check("resolve", false, "no server on this machine");
    return { lang, server: null, results };
  }
  // What the fixture needs before a server can answer about it: a compilation
  // database clangd can read, a Swift package that has been built once. Run
  // AFTER resolution so a machine without the server pays nothing.
  cfg.prepare?.(cfg.root);
  const [exe, args] = resolved;
  check("resolve", true, path.basename(exe));

  const conn = connect(exe, args, cfg.root, cfg.languageId);
  const rootUri = uriFor(cfg.root);
  const init = await Promise.race([
    conn.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "termic-lsp-smoke" },
      rootUri, rootPath: cfg.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(cfg.root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: {} },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {}, references: {}, publishDiagnostics: {},
        },
      },
    }),
    wait(30_000).then(() => ({ __timeout: true })),
  ]);
  if (!init || init.__timeout || init.__error) {
    check("initialize", false, init?.__error ? JSON.stringify(init.__error).slice(0, 120) : "timed out");
    conn.child.kill("SIGKILL");
    return { lang, server: path.basename(exe), results };
  }
  conn.notify("initialized", {});

  const open = (rel) => {
    const abs = path.join(cfg.root, rel);
    conn.notify("textDocument/didOpen", {
      textDocument: {
        uri: uriFor(abs), languageId: cfg.languageId, version: 1,
        text: readFileSync(abs, "utf8"),
      },
    });
    return uriFor(abs);
  };

  const useUri = open(cfg.use.file);
  const pos = { line: cfg.use.line - 1, character: cfg.use.col - 1 };
  // Indexing: rust-analyzer and gopls need a beat before they answer.
  const budget = lang === "rust" || lang === "go" ? 60_000 : 25_000;

  let hover = null, def = null;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    hover = await Promise.race([
      conn.request("textDocument/hover", { textDocument: { uri: useUri }, position: pos }),
      wait(8_000),
    ]);
    def = await Promise.race([
      conn.request("textDocument/definition", { textDocument: { uri: useUri }, position: pos }),
      wait(8_000),
    ]);
    // BOTH, not either. rust-analyzer answered the definition on the first
    // pass while hover was still warming up, and breaking on the first answer
    // recorded an empty hover as a failure of the server rather than of the
    // wait.
    const gotDef = def && (Array.isArray(def) ? def.length : def.uri);
    if (hover?.contents && gotDef) break;
    await wait(1500);
  }

  check("hover", !!hover?.contents,
    hover?.contents ? String(hover.contents.value ?? "").split("\n")[0].slice(0, 60) : "empty");

  const locs = Array.isArray(def) ? def : def ? [def] : [];
  const target = locs[0]?.uri ?? locs[0]?.targetUri ?? "";
  check("definition", target.endsWith(cfg.definedIn),
    target ? target.split("/").slice(-2).join("/") : "no location");

  // workspace/symbol, plus the raw answer for the offline fixture.
  //
  // RETRIED, because several servers answer this one from an index they build
  // in the background and answer `[]` until it is ready rather than waiting:
  // clangd on a two-file fixture takes a couple of seconds. Asking once was
  // reporting "0 answers" for a server that works, and it is the same race a
  // user hits by pressing double-shift immediately after arming.
  let list = [];
  let defining = null;
  const symbolDeadline = Date.now() + 30_000;
  for (;;) {
    const symbols = await Promise.race([
      conn.request("workspace/symbol", { query: cfg.symbolQuery }),
      wait(20_000),
    ]);
    list = Array.isArray(symbols) ? symbols : [];
    defining = list.find(s =>
      s.name === cfg.symbolQuery && (s.location?.uri ?? "").endsWith(cfg.definedIn));
    if (defining || Date.now() > symbolDeadline) break;
    await wait(1_000);
  }
  check("symbols", !!defining, `${list.length} answers`);

  if (RECORD && list.length) {
    const out = {
      server: path.basename(exe), language: lang, query: cfg.symbolQuery,
      // Recorded so the offline test can assert the RIGHT answer ranks first
      // rather than a filename pattern that happens to hold for six of the
      // seven fixtures (`src/lib.rs` is where Rust puts it).
      definedIn: cfg.definedIn,
      symbols: list.map(s => ({
        name: s.name, kind: s.kind,
        file: (s.location?.uri ?? "").replace(uriFor(cfg.root) + "/", ""),
        line: (s.location?.range?.start?.line ?? 0) + 1,
      })),
    };
    const file = path.join(fixtures, `symbols.smoke-${lang}.json`);
    writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
    check("recorded", true, path.basename(file));
  }

  if (cfg.broken) {
    const brokenUri = open(cfg.broken);
    let diags = [];
    const dl = Date.now() + 20_000;
    while (Date.now() < dl) {
      const pulled = await Promise.race([
        conn.request("textDocument/diagnostic", { textDocument: { uri: brokenUri } }),
        wait(6_000),
      ]);
      const pulledItems = pulled?.items ?? [];
      const pushedItems = conn.pushed
        .filter(p => p.uri === brokenUri).flatMap(p => p.diagnostics ?? []);
      diags = [...pulledItems, ...pushedItems];
      if (diags.length) break;
      await wait(1500);
    }
    check("diagnostics", diags.length > 0, `${diags.length}`);
    if (cfg.undefinedName) {
      const named = diags.some(d => (d.message ?? "").includes(cfg.undefinedName));
      check("undefined", named, named ? cfg.undefinedName : "not reported");
    }
  }

  conn.child.kill("SIGKILL");
  return { lang, server: path.basename(exe), results };
}

const langs = ONLY ? [ONLY] : Object.keys(CASES);
let failed = 0;
for (const lang of langs) {
  const cfg = CASES[lang];
  if (!cfg) { console.error(`unknown language: ${lang}`); process.exit(2); }
  const { server, results } = await runLanguage(lang, cfg);
  console.log(`\n${lang}${server ? `  (${server})` : ""}`);
  for (const r of results) {
    // A server this machine does not have is reported, not failed: nobody has
    // all of them, and a smoke run that always fails is a run nobody makes.
    const skip = r.name === "resolve" && !r.ok;
    if (!r.ok && !skip) failed++;
    console.log(`  ${skip ? "-" : r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(12)} ${r.detail}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
