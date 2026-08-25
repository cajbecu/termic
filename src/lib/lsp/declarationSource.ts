// From a declaration to the code it declares (GH #174).
//
// Servers resolve imports through TYPE STUBS when a package has them, so
// ⌘-clicking a Django model lands in `django-stubs/db/models/base.pyi` — a
// file of signatures with `...` for every body. That is the correct answer to
// "what is the type of this", and the wrong answer to "show me this code",
// which is the entire point of reading someone else's project.
//
// Measured before designing this: ty and basedpyright both answer the stub for
// `definition`, `declaration` AND `implementation`, and basedpyright does not
// hop even when asked from inside the stub. Pylance solved it by splitting the
// two requests (definition → source, declaration → stub); that split is not
// available over plain LSP here, so the client does the last step itself.
//
// Deliberately a TABLE, not a Python special case: the same problem is
// `node_modules/@types/react/index.d.ts` in TypeScript, and languages with no
// declaration files (Rust, Go) fall through untouched.

/** A language whose declarations live in a separate file. */
interface DeclarationKind {
  /** Suffix that marks a declaration-only file. */
  suffix: string;
  /** Extensions the implementation might use, in preference order. */
  sourceExts: string[];
  /** Lines that look like a definition of `symbol`, best first. Each gets the
   *  symbol interpolated; the last resort is a plain word match. */
  patterns: (symbol: string) => RegExp[];
}

const KINDS: DeclarationKind[] = [
  {
    suffix: ".pyi",
    sourceExts: [".py"],
    patterns: (s) => [
      new RegExp(`^\\s*(?:async\\s+)?def\\s+${s}\\b`),
      new RegExp(`^\\s*class\\s+${s}\\b`),
      new RegExp(`^\\s*${s}\\s*[:=]`),
    ],
  },
  {
    suffix: ".d.ts",
    sourceExts: [".ts", ".tsx", ".js", ".mjs"],
    patterns: (s) => [
      new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${s}\\b`),
      new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${s}\\b`),
      new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|type|interface|enum)\\s+${s}\\b`),
    ],
  },
];

function kindFor(path: string): DeclarationKind | null {
  return KINDS.find(k => path.endsWith(k.suffix)) ?? null;
}

/** Is this a file of declarations rather than code? */
export function isDeclarationOnly(path: string): boolean {
  return kindFor(path) !== null;
}

/**
 * Where the implementation for a declaration file might live, best first.
 *
 * Two shapes cover almost everything in the wild:
 *
 *  - **Beside it.** `foo/bar.pyi` next to `foo/bar.py`, which is what an
 *    inline (PEP 561 `py.typed`) package ships.
 *  - **A stub-only distribution.** PEP 561 names those `<package>-stubs`, so
 *    `site-packages/django-stubs/db/models/base.pyi` is describing
 *    `site-packages/django/db/models/base.py`. The rename is mechanical, which
 *    is what makes it safe to follow.
 *
 * TypeScript's `@types/<pkg>` is the same idea with a different spelling.
 */
export function sourceCandidates(declPath: string): string[] {
  const kind = kindFor(declPath);
  if (!kind) return [];
  const base = declPath.slice(0, -kind.suffix.length);
  const out: string[] = [];
  const add = (stem: string) => {
    for (const ext of kind.sourceExts) out.push(stem + ext);
  };

  add(base);                                     // right beside the declaration

  // A stub-only distribution: `<pkg>-stubs/rest` → `<pkg>/rest`.
  const stubDir = base.replace(/(^|\/)([^/]+)-stubs\//, (_m, lead, pkg) => `${lead}${pkg}/`);
  if (stubDir !== base) add(stubDir);

  // TypeScript's version of the same: `@types/<pkg>/x` → `<pkg>/x`.
  const typesDir = base.replace(/(^|\/)@types\/([^/]+)\//, (_m, lead, pkg) => `${lead}${pkg}/`);
  if (typesDir !== base) add(typesDir);

  // Deliberately NOT guessing `dist/` → `src/`. It is a real convention, but
  // it is a convention rather than a rule, and this path is only reached when
  // the answer will be FOLLOWED: a wrong guess silently lands the reader in
  // an unrelated file. The two mappings above are mechanical (PEP 561 names
  // stub distributions `<pkg>-stubs`, DefinitelyTyped uses `@types/<pkg>`),
  // which is what makes them safe to follow without asking.

  return [...new Set(out)];
}

/**
 * The line in `text` that DEFINES `symbol`, 1-based, or null.
 *
 * Definition-shaped lines only, and this is the interesting part: an earlier
 * version fell back to any mention of the word, which measured badly against
 * real Django. `Model.objects` has no definition in `django/db/models/base.py`
 * at all (the metaclass installs it), so the fallback landed on line 435,
 * `if any(f.name == "objects" for f in opts.fields)`. That is not "the right
 * file at the wrong line", it is a coincidence, and following it silently
 * takes the reader somewhere the symbol is not. Returning null keeps them on
 * the stub, which is at least an honest answer about where the declaration is.
 *
 * The same file measured correctly for everything actually defined there:
 * `Model` → `class Model(...)` at 501, `save` → `def save(` at 841,
 * `refresh_from_db` → 735, `ModelBase` → 95.
 */
export function findSymbolLine(text: string, symbol: string, declPath: string): number | null {
  const kind = kindFor(declPath);
  if (!kind || !symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) return null;
  const lines = text.split("\n");
  for (const pattern of kind.patterns(symbol)) {
    const i = lines.findIndex(l => pattern.test(l));
    if (i >= 0) return i + 1;
  }
  return null;
}
