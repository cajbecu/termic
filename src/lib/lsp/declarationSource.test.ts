import { describe, it, expect } from "vitest";
import { isDeclarationOnly, sourceCandidates, findSymbolLine } from "./declarationSource";

// ⌘-clicking a Django model landed in `django-stubs/db/models/base.pyi`: a
// file of signatures with `...` for every body. Correct as a type answer,
// useless as "show me this code" — and reading someone else's project is the
// whole point. Measured first: ty and basedpyright both answer the stub for
// definition, declaration AND implementation, so the last hop is ours.

describe("which files are declarations", () => {
  it("knows the two that exist in the wild", () => {
    expect(isDeclarationOnly("/x/django-stubs/db/models/base.pyi")).toBe(true);
    expect(isDeclarationOnly("/x/node_modules/@types/react/index.d.ts")).toBe(true);
  });

  it("leaves languages without stubs alone", () => {
    // Rust and Go have no declaration files, so nothing here may fire for
    // them: a wrong hop would send the reader somewhere the symbol is not.
    expect(isDeclarationOnly("/x/src/main.rs")).toBe(false);
    expect(isDeclarationOnly("/x/pkg/server.go")).toBe(false);
    expect(isDeclarationOnly("/x/app/models.py")).toBe(false);
    expect(isDeclarationOnly("/x/src/app.ts")).toBe(false);
  });
});

describe("where the implementation lives", () => {
  it("follows a stub-only distribution back to its package", () => {
    // PEP 561 names them `<package>-stubs`, which makes the rename mechanical
    // — and mechanical is what makes it safe to follow automatically.
    const out = sourceCandidates("/venv/site-packages/django-stubs/db/models/base.pyi");
    expect(out).toContain("/venv/site-packages/django/db/models/base.py");
  });

  it("looks beside the declaration first", () => {
    // An inline (py.typed) package ships `bar.pyi` next to `bar.py`, and the
    // neighbour is a better answer than a package-level guess.
    const out = sourceCandidates("/venv/site-packages/attrs/converters.pyi");
    expect(out[0]).toBe("/venv/site-packages/attrs/converters.py");
  });

  it("does the same for TypeScript, which has the same problem", () => {
    const types = sourceCandidates("/app/node_modules/@types/react/index.d.ts");
    expect(types).toContain("/app/node_modules/react/index.ts");
    // And NOT a guess at `dist/` → `src/`. That is a convention rather than a
    // rule, and this answer gets followed: a wrong guess lands the reader in
    // an unrelated file, which is worse than the declaration they asked about.
    const dist = sourceCandidates("/app/node_modules/zod/dist/index.d.ts");
    expect(dist).not.toContain("/app/node_modules/zod/src/index.ts");
  });

  it("has nothing to say about a file that is already source", () => {
    expect(sourceCandidates("/x/app/models.py")).toEqual([]);
    expect(sourceCandidates("/x/src/main.rs")).toEqual([]);
  });
});

describe("finding the symbol in the source", () => {
  const py = [
    "import os",
    "",
    "objects = None",
    "",
    "",
    "class Model:",
    "    def save(self):",
    "        pass",
  ].join("\n");

  it("prefers a line that DEFINES the symbol", () => {
    // `class Model:` at line 6, not the mention of Model anywhere earlier.
    expect(findSymbolLine(py, "Model", "/x/base.pyi")).toBe(6);
    expect(findSymbolLine(py, "save", "/x/base.pyi")).toBe(7);
    expect(findSymbolLine(py, "objects", "/x/base.pyi")).toBe(3);
  });

  it("refuses a mention that is not a definition", () => {
    // Measured against real Django: `Model.objects` is installed by the
    // metaclass and defined nowhere in `django/db/models/base.py`, so a
    // word-match fallback landed on line 435,
    // `if any(f.name == "objects" for f in opts.fields)`. That is a
    // coincidence, not a destination — null keeps the reader on the stub,
    // which is at least honest about where the declaration is.
    expect(findSymbolLine("a = 1\nuses(thing)\n", "thing", "/x/base.pyi")).toBeNull();
    expect(findSymbolLine('if any(f.name == "objects" for f in opts.fields):\n', "objects", "/x/base.pyi"))
      .toBeNull();
  });

  it("uses the right patterns for TypeScript", () => {
    const ts = ["import x from 'y';", "", "export class Widget {", "  render() {}", "}"].join("\n");
    expect(findSymbolLine(ts, "Widget", "/x/index.d.ts")).toBe(3);
  });

  it("refuses a symbol that is not an identifier", () => {
    // Anything else would be interpolated straight into a RegExp.
    expect(findSymbolLine(py, "Model(", "/x/base.pyi")).toBeNull();
    expect(findSymbolLine(py, ".*", "/x/base.pyi")).toBeNull();
    expect(findSymbolLine(py, "", "/x/base.pyi")).toBeNull();
  });

  it("says nothing when the file is not a declaration", () => {
    expect(findSymbolLine(py, "Model", "/x/base.py")).toBeNull();
  });
});
