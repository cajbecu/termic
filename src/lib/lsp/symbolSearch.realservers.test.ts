import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { KIND_LABEL, keepMatching, preferDefinitions, rankSymbols, type SymbolHit } from "./symbolSearch";

// The same pipeline searchSymbols runs, over answers RECORDED FROM THE REAL
// SERVERS rather than invented ones.
//
// The bug this exists for could not have been written from imagination: asking
// zuban for `Store` in a Django project returns 95 symbols, 64 of which are
// the `from stores.models import Store` line in some other module, and nothing
// in the protocol says so. They are simply the binding an import creates, and
// a binding is a variable. Ranked by name alone they tied with the class and
// beat it on the tiebreak, so the definition fell off the end of a 25-row list
// and the search looked unable to find a class sitting in the same repo.
//
// Each fixture is one query against one server, captured with
// scratchpad/lsp-probe.mjs:
//
//   zuban          "Store"      a real Django project     95 symbols
//   tsgo           "EditorPane" this repo                  2 symbols
//   rust-analyzer  "LspServer"  this repo's src-tauri      2 symbols
//   gopls          "Store"      a two-package Go module    6 symbols
//
// Re-record with:
//   SYMBOL_QUERY=Store SYMBOL_OUT=<file> node scratchpad/lsp-probe.mjs <lang> <root> <file>

interface Fixture {
  server: string;
  language: string;
  query: string;
  symbols: Array<{ name: string; kind: number; file: string; line: number }>;
  /** Where the query's definition lives, per the smoke harness. Only the
   *  `smoke-*` recordings carry it; the hand-captured ones predate it. */
  definedIn?: string;
}

// The label map is IMPORTED, not copied. A second table here is how kinds 22
// and 23 stayed swapped in production while this file reported everything fine:
// its header claims "the same pipeline searchSymbols runs", and a private map
// made that false exactly where it mattered.

function load(name: string): { fx: Fixture; hits: SymbolHit[] } {
  const file = path.join(__dirname, "__fixtures__", `symbols.${name}.json`);
  const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  const hits = fx.symbols.map(s => ({
    name: s.name,
    kind: KIND_LABEL[s.kind] ?? "symbol",
    kindCode: s.kind,
    path: `/repo/${s.file}`,
    file: s.file,
    line: s.line,
    server: fx.language,
  }));
  return { fx, hits };
}

/** What the dialog would show. */
const results = (name: string) => {
  const { fx, hits } = load(name);
  return { fx, out: rankSymbols(keepMatching(preferDefinitions(hits), fx.query), fx.query) };
};

const LANGUAGES = ["python-zuban", "typescript-tsgo", "rust-analyzer", "go-gopls"];

describe("what ⇧⇧ shows, over real server answers", () => {
  it.each(LANGUAGES)("%s: every row's name contains what was typed", (name) => {
    const { fx, out } = results(name);
    expect(out.length).toBeGreaterThan(0);
    for (const hit of out) {
      expect(hit.name.toLowerCase()).toContain(fx.query.toLowerCase());
    }
  });

  it.each(LANGUAGES)("%s: no import sites of a name defined in the answer", (name) => {
    const { out } = results(name);
    // A binding kind (variable / constant) may only survive when nothing in
    // the answer DEFINES that name.
    const defined = new Set(out.filter(h => h.kindCode !== 13 && h.kindCode !== 14).map(h => h.name));
    for (const hit of out) {
      if (hit.kindCode === 13 || hit.kindCode === 14) expect(defined.has(hit.name)).toBe(false);
    }
  });

  it.each(LANGUAGES)("%s: an exact match leads, and prefixes come before substrings", (name) => {
    const { fx, out } = results(name);
    const q = fx.query.toLowerCase();
    const rank = (h: SymbolHit) =>
      h.name.toLowerCase() === q ? 0 : h.name.toLowerCase().startsWith(q) ? 1 : 2;
    const ranks = out.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("python: the class survives 64 imports of it, and leads", () => {
    // The exact failure from the screenshot: 25 rows, all imports, no class.
    const { fx, hits } = load("python-zuban");
    expect(hits.filter(h => h.kindCode === 13)).toHaveLength(64);

    const out = rankSymbols(keepMatching(preferDefinitions(hits), fx.query), fx.query);
    expect(out[0]).toMatchObject({ name: "Store", file: "stores/models.py", line: 64 });
    // Every import site of a defined name is gone; what remains is definitions.
    expect(out.filter(h => h.kindCode === 13)).toHaveLength(0);
    // 95 rows in, 31 out, and all of them classes. PyCharm's own list for this
    // project is the same set; it orders the tail alphabetically where this
    // puts the shortest name first, which is the tiebreak rankSymbols has
    // always used and the one VS Code uses too.
    expect(out).toHaveLength(31);
    expect(out.slice(0, 4).map(h => h.name)).toEqual([
      "Store", "StoreOut", "StorePage", "StoreAdmin",
    ]);
  });

  it("typescript: a lazy import of a component is not a definition of it", () => {
    // tsgo reports `EditorPane` twice: the function that declares it, and the
    // `const EditorPane = lazy(() => import(...))` binding in TaskView.
    const { fx, hits } = load("typescript-tsgo");
    expect(hits).toHaveLength(2);
    const out = rankSymbols(keepMatching(preferDefinitions(hits), fx.query), fx.query);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/components/task/EditorPane.tsx");
  });

  it("go and rust need no cleaning, and must not be damaged by it", () => {
    // Neither server reports import bindings at all: gopls answers structs,
    // fields and functions, rust-analyzer answers structs. The filter has to
    // be a no-op here, which is the half of a filter that usually breaks.
    for (const name of ["go-gopls", "rust-analyzer"]) {
      const { fx, hits } = load(name);
      expect(preferDefinitions(hits)).toHaveLength(hits.length);
      expect(keepMatching(hits, fx.query)).toHaveLength(hits.length);
    }
  });

  it("keeps a camel-hump answer when nothing literally matches", () => {
    // Measured: rust-analyzer answers `LsSrv` with `LspServer`, gopls answers
    // `SB` with `StoreByID`. No name contains the query, and JetBrains matches
    // the same way, so dropping them would trade a feature for an empty list.
    const { hits } = load("rust-analyzer");
    expect(keepMatching(hits, "LsSrv").map(h => h.name)).toEqual(["LspServer", "LspServerInfo"]);
  });
});

describe("nothing reaches the list that the query cannot explain", () => {
  // The CLASS of bug, not the instance. `serverQueries` deliberately asks each
  // server a broader question than the user typed (every casing of the first
  // two characters), so the raw answer is a superset by construction and any
  // path that hands it back unfiltered fills the dialog with rows that have
  // nothing to do with the query. That is what shipped: `storeadmsssssss`
  // returned `Status`, `last_ids` and `CustomSet`.
  //
  // Run over the RECORDED answers, so the inputs are the real over-fetch and
  // not something invented to suit the assertion.
  const QUERIES = [
    "Store",          // exact, in every fixture
    "store",          // wrong case
    "st",             // the two characters the superset is fetched by
    "StoreAdmin",     // longer than anything some fixtures hold
    "storeadmsssssss",// the reported one: starts like a real name, then rubbish
    "zzzzzz",         // nothing at all
    "S",              // a single character
    "",               // empty, which must not throw
  ];

  /** Can this row be explained by that query, at all? Either the name contains
   *  it, or every character of it appears in order (the camel-hump tier that
   *  makes `LsSrv` find `LspServer`). */
  const explainable = (name: string, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    let i = 0;
    for (const ch of name.toLowerCase()) if (ch === q[i]) i++;
    return i === q.length;
  };

  for (const language of LANGUAGES) {
    for (const query of QUERIES) {
      it(`${language}: ${query || "(empty)"} explains every row it produces`, () => {
        const { hits } = load(language);
        const out = rankSymbols(keepMatching(preferDefinitions(hits), query), query);
        for (const row of out) {
          expect(explainable(row.name, query), `${row.name} for "${query}"`).toBe(true);
        }
      });
    }

    it(`${language}: gibberish produces an empty list, not the whole answer`, () => {
      const { hits } = load(language);
      const out = rankSymbols(keepMatching(preferDefinitions(hits), "qqzzxwv"), "qqzzxwv");
      expect(out).toEqual([]);
    });
  }
});

// Every language, from `make lsp-smoke --record`: one query against one real
// server on a fixture project small enough to reason about. These are thinner
// than the captures above (a two-file project answers with a handful of
// symbols, not ninety-five), and they are here for BREADTH rather than depth:
// seven servers now feed this pipeline, each with its own idea of what a
// workspace symbol is, and the invariant a reader depends on is the same for
// all of them.
describe("every server termic ships, over its recorded answer", () => {
  const names = readdirSync(path.join(__dirname, "__fixtures__"))
    .filter(f => f.startsWith("symbols.smoke-"))
    .map(f => f.replace(/^symbols\.|\.json$/g, ""));

  it("has a recording for each of the seven languages", () => {
    // A missing one means somebody added a language and never ran the smoke
    // harness against it, which is exactly the gap this file exists to close.
    expect(names.length).toBe(7);
  });

  for (const name of names) {
    it(`puts the definition first for ${name}`, () => {
      const { fx, out } = results(name);
      expect(out.length).toBeGreaterThan(0);
      // The thing you searched for, at the top. Every fixture queries "Store"
      // (or the language's equivalent) against a project where exactly one
      // definition of it exists, so anything else in first place is the
      // ranking preferring a use, an import binding, or a longer name.
      expect(out[0].name).toBe(fx.query);
      // And it is the DEFINITION: the file the smoke harness proved
      // go-to-definition lands in, recorded alongside the answer.
      expect(out[0].file).toBe(fx.definedIn);
    });

    it(`returns nothing rather than noise for an absent name in ${name}`, () => {
      // The bug a user reported: once nothing matched, the dialog spilled the
      // server's whole unfiltered answer into the list.
      const { hits } = load(name);
      expect(keepMatching(preferDefinitions(hits), "zzzznotasymbol")).toEqual([]);
    });
  }
});
