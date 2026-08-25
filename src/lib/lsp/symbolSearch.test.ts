import { describe, it, expect } from "vitest";
import { keepMatching, preferDefinitions, rankSymbols, serverQueries, type SymbolHit } from "./symbolSearch";

// Symbol search is the one navigation feature reached with NO file open, so it
// asks every server armed for the checkout and merges. A merged list has to be
// re-ranked: otherwise the first result is whichever server answered first,
// which to the reader looks like the feature picking at random.

const hit = (name: string, file = "a.py", kindCode = 5): SymbolHit => ({
  name, kind: "class", kindCode, path: `/repo/${file}`, file, line: 1, server: "python",
});

describe("ranking a merged answer", () => {
  it("puts an exact name first, then a prefix, then a substring", () => {
    const out = rankSymbols(
      [hit("MyStorePage"), hit("StorePageSerializer"), hit("StorePage")],
      "StorePage",
    );
    expect(out.map(h => h.name)).toEqual(["StorePage", "StorePageSerializer", "MyStorePage"]);
  });

  it("prefers the shorter name when the rank is the same", () => {
    // Both are prefix matches; the shorter one is nearly always the thing you
    // meant, and it is what every IDE surfaces first.
    const out = rankSymbols([hit("StorePageAdminInline"), hit("StorePageAdmin")], "StorePage");
    expect(out[0].name).toBe("StorePageAdmin");
  });

  it("is stable and case-insensitive", () => {
    const out = rankSymbols([hit("storepage", "b.py"), hit("StorePage", "a.py")], "storepage");
    expect(out.map(h => h.name)).toEqual(["storepage", "StorePage"]);
  });

  it("keeps rows that only match loosely rather than dropping them", () => {
    // The server decided these are answers; re-ranking must not become a
    // second filter that hides them.
    const out = rankSymbols([hit("unrelated")], "store");
    expect(out).toHaveLength(1);
  });

  it("puts a definition above a binding it could not drop", () => {
    const out = rankSymbols([binding("CACHE", "a.py"), hit("CACHE", "b.py")], "CACHE");
    expect(out[0].file).toBe("b.py");
  });
});

/** A name imported into another module: the kind every Python server reports
 *  for the binding an `import` creates. */
const binding = (name: string, file: string): SymbolHit =>
  ({ ...hit(name, file), kind: "variable", kindCode: 13 });

describe("definitions over import sites", () => {
  it("drops the import sites of a name that is defined in the answer", () => {
    // The real shape, from zuban on a Django project: one `class Store` and a
    // pile of modules that import it. The imports crowded the definition off
    // the end of a 25-row list, so the search looked like it could not find a
    // class that was sitting right there.
    const out = preferDefinitions([
      binding("Store", "api/endpoints/config.py"),
      binding("Store", "guapa_api/endpoints/offers.py"),
      hit("Store", "stores/models.py"),
      binding("Store", "offers/models.py"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("stores/models.py");
  });

  it("keeps a binding whose name is defined nowhere in the answer", () => {
    // A constant, or a name imported from a dependency the server cannot see
    // into. The import site is then the only place to go, and no row at all
    // would be a worse answer than an imprecise one.
    const out = preferDefinitions([binding("SETTINGS", "app/conf.py")]);
    expect(out.map(h => h.file)).toEqual(["app/conf.py"]);
  });

  it("judges each name on its own", () => {
    const out = preferDefinitions([
      binding("Store", "a.py"), hit("Store", "models.py"),
      binding("SETTINGS", "conf.py"),
    ]);
    expect(out.map(h => h.file).sort()).toEqual(["conf.py", "models.py"]);
  });

  it("leaves an answer of only definitions alone", () => {
    const hits = [hit("StoreAdmin", "admin.py"), hit("Store", "models.py")];
    expect(preferDefinitions(hits)).toEqual(hits);
  });
});

describe("case is the client's problem, not the server's", () => {
  it("asks for every casing of the first two characters", () => {
    // zuban matches case-sensitively: `AISetup` answered 26 symbols on a real
    // project and `AiSetup` answered ZERO, so the symbols section vanished for
    // a query that differed only in a capital letter. Any name containing
    // `aisetup` in some casing contains `ai` in some casing, so this is the
    // superset the client can then narrow.
    const qs = serverQueries("AiSetup");
    expect(qs).toContain("AiSetup");   // the precise one, in case of result caps
    expect(qs).toEqual(expect.arrayContaining(["ai", "Ai", "aI", "AI"]));
  });

  it("does not multiply queries that have nothing to case", () => {
    // Digits and separators fold together, so the set stays small.
    expect(serverQueries("12_ab")).toEqual(["12_ab", "12"]);
    expect(serverQueries("ai")).toHaveLength(4);
    expect(serverQueries("")).toEqual([]);
  });

  it("matches a name whose casing differs from the query", () => {
    const hits = [hit("AISetupOut"), hit("StoreAISetup"), hit("Unrelated")];
    expect(keepMatching(hits, "aisetup").map(h => h.name))
      .toEqual(["AISetupOut", "StoreAISetup"]);
    expect(keepMatching(hits, "AiSetup").map(h => h.name))
      .toEqual(["AISetupOut", "StoreAISetup"]);
  });

  it("finds a snake_case name from a run-together query", () => {
    // What PyCharm does, and what the ⌘P matcher already did for filenames:
    // `aisetup` should find `ai_setup`, because a separator is not a letter
    // the reader thinks they are typing.
    const out = keepMatching([hit("ai_setup"), hit("nothing")], "aisetup");
    expect(out.map(h => h.name)).toEqual(["ai_setup"]);
  });
});

describe("when nothing matches", () => {
  it("answers with nothing, not with everything the server sent", () => {
    // The server is asked a DELIBERATELY broad question (every casing of the
    // first two characters), so its raw answer is a superset that has no
    // relationship to what was typed. Handing it back on a miss filled the
    // dialog with `Status`, `last_ids` and `CustomSet` for a query of
    // `storeadmsssssss`.
    const hits = [hit("Status"), hit("StoreOut"), hit("last_ids"), hit("CustomSet")];
    expect(keepMatching(hits, "storeadmsssssss")).toEqual([]);
  });

  it("still allows the camel-hump answer a server matched on purpose", () => {
    // The subsequence tier is what makes `LsSrv` find `LspServer`, and it
    // requires every character in order, so gibberish cannot ride in on it.
    expect(keepMatching([hit("LspServer")], "LsSrv").map(h => h.name)).toEqual(["LspServer"]);
    expect(keepMatching([hit("LspServer")], "zzzz")).toEqual([]);
  });
});

describe("the over-fetch contract", () => {
  // `serverQueries` exists because servers disagree about case, and it works by
  // asking a BROADER question than the user typed. Two things have to hold for
  // that trade to be sound, and both were violated at different times:
  //
  //   1. it really is a superset (or the client filters away real answers), and
  //   2. nothing downstream trusts the raw answer (or the extra rows ship).
  //
  // (2) is pinned in symbolSearch.realservers.test.ts against recorded server
  // output. This is (1).

  /** What a case-sensitive substring server would return for one query. */
  const serverWouldReturn = (names: readonly string[], query: string) =>
    names.filter(n => n.includes(query));

  it("asks for a superset of what the exact query would have found", () => {
    const names = [
      "Store", "StoreAdmin", "storeFactory", "STORE_ROOT", "MyStore",
      "aiSetup", "AISetup", "ai_setup", "Unrelated",
    ];
    for (const query of ["Store", "store", "STORE", "aiSetup", "AISetup", "ai"]) {
      const broad = new Set(
        serverQueries(query).flatMap(q => serverWouldReturn(names, q)),
      );
      // Everything the precise question would have found is in the broad one.
      for (const name of serverWouldReturn(names, query)) {
        expect(broad.has(name), `${name} missing from the superset for "${query}"`).toBe(true);
      }
      // And so is every name that matches ignoring case, which is the point:
      // it is what lets the client answer a question the server would not.
      for (const name of names.filter(n => n.toLowerCase().includes(query.toLowerCase()))) {
        expect(broad.has(name), `${name} unreachable for "${query}"`).toBe(true);
      }
    }
  });

  it("stays small: two characters is four queries, whatever the query length", () => {
    // The cost of the trade. If this ever grows with the query, every keystroke
    // becomes N requests per armed server.
    for (const query of ["ab", "abcdefghijklmnop", "AbC", "a1"]) {
      expect(serverQueries(query).length).toBeLessThanOrEqual(5);
    }
  });
});

describe("the case you typed is information", () => {
  it("puts the constants first for a SHOUTED query", () => {
    // Matching stays case-insensitive (servers disagree about case, so the
    // client owns it), but someone who typed REVIEW is looking for the
    // constants. Ranking by length alone put `review_pr` above
    // `REVIEW_SCHEMA` purely because it is shorter.
    const out = rankSymbols(
      [hit("review_pr"), hit("REVIEW_SCHEMA"), hit("ReviewResult"), hit("REVIEW_TEMPLATE")],
      "REVIEW",
    );
    expect(out.slice(0, 2).map(h => h.name)).toEqual(["REVIEW_SCHEMA", "REVIEW_TEMPLATE"]);
  });

  it("puts the functions first for a lowercase one", () => {
    const out = rankSymbols(
      [hit("REVIEW_SCHEMA"), hit("review_pr"), hit("review_single_pr")],
      "review",
    );
    expect(out[0].name).toBe("review_pr");
  });

  it("still ranks an exact name above a longer one that merely contains it", () => {
    // Case is a TIEBREAK, not a promotion: it must not outrank the match
    // quality that comes before it.
    const out = rankSymbols([hit("REVIEW_SCHEMA"), hit("review")], "review");
    expect(out[0].name).toBe("review");
  });
});

describe("the order of the tiebreaks", () => {
  it("ranks WHERE it matched above HOW it was cased", () => {
    // The rule, spelled out: exact name, then prefix, then containment, and
    // only WITHIN one of those does the case you typed decide. A name that
    // starts with what you typed is a better answer than one that merely
    // contains it, even when the second one matches your capitals: you are
    // looking for a name, and the front of a name is where you recognise it.
    const out = rankSymbols([hit("post_REVIEW"), hit("review_pr")], "REVIEW");
    expect(out[0].name).toBe("review_pr");   // startsWith wins the tier
  });

  it("and within one tier, the case decides", () => {
    const out = rankSymbols([hit("review_pr"), hit("REVIEW_SCHEMA")], "REVIEW");
    expect(out[0].name).toBe("REVIEW_SCHEMA");
  });

  it("with a definition still outranking an import OF THE SAME NAME", () => {
    // An import binding carries the same name as the thing it imports, which
    // is the only comparison this rule was ever about. Applied across names it
    // demoted every module-level constant below every function, because LSP
    // reports a constant as kind 13, the same kind a binding arrives as.
    const out = rankSymbols(
      [{ ...hit("REVIEW_SCHEMA"), kind: "variable", kindCode: 13, file: "uses.py" },
       { ...hit("REVIEW_SCHEMA"), file: "defines.py" }],
      "REVIEW_SCHEMA",
    );
    expect(out[0].file).toBe("defines.py");
  });

  it("does not demote a constant below an unrelated function", () => {
    // The screenshot that started this: REVIEW in a Python project put three
    // functions above the three constants the capitals were asking for.
    const out = rankSymbols(
      [hit("review_pr"), { ...hit("REVIEW_SCHEMA"), kind: "variable", kindCode: 13 }],
      "REVIEW",
    );
    expect(out[0].name).toBe("REVIEW_SCHEMA");
  });
});

describe("a name imported everywhere", () => {
  const importOf = (name: string, file: string): SymbolHit =>
    ({ ...hit(name, file), kind: "variable", kindCode: 13 });

  it("shows one import site and counts the rest", () => {
    // Searching DJANGO in a Django project returned fifty rows reading
    // "django variable", one per migration that says `import django`. The
    // package is defined outside the project, so the escape hatch that keeps
    // a binding when nothing defines its name kept every single one.
    const hits = Array.from({ length: 50 }, (_, i) =>
      importOf("django", `app/migrations/${i}.py`));
    const out = preferDefinitions(hits);
    expect(out).toHaveLength(1);
    expect(out[0].alsoIn).toBe(49);
  });

  it("still drops them all when the name IS defined here", () => {
    // The stronger rule wins: an import of something this project defines is
    // never the answer, however many there are.
    const hits = [...Array.from({ length: 5 }, (_, i) => importOf("Store", `uses${i}.py`)),
                  hit("Store", "models.py")];
    const out = preferDefinitions(hits);
    expect(out.map(h => h.file)).toEqual(["models.py"]);
  });

  it("does not collapse distinct names, or definitions", () => {
    // Two constants that happen to be variables are two answers, and three
    // functions are three answers.
    const hits = [importOf("A", "a.py"), importOf("B", "b.py"),
                  hit("f1", "x.py"), hit("f2", "y.py"), hit("f3", "z.py")];
    expect(preferDefinitions(hits)).toHaveLength(5);
  });
});
