// What is this project written in, when no file is open to ask (GH #174).
//
// Double-shift with nothing in the editor is exactly when someone wants to
// find a symbol, and exactly when the app has no buffer to take a language
// from. The dialog used to shrug: "Search files", no symbols, and no way to
// discover that symbol search exists at all.
//
// The answer is already in the file list the dialog fetched, so this costs no
// IPC and no directory walk. Two signals, because either alone is wrong:
//
//   - **Manifests.** `pyproject.toml` says Python about a repo whose Python is
//     one script, and that is the right answer: somebody set it up as a Python
//     project.
//   - **Extension counts.** A repo with 300 `.py` files and no manifest is a
//     Python project whatever its root looks like, and plenty of real trees
//     (scripts, monorepo subtrees, anything vendored) have no manifest on top.
//
// Ordered by strength, so the dialog leads with what the project is most
// obviously about.

/** Marker file (exact basename) → server id. */
const MARKERS: Record<string, string> = {
  "package.json": "typescript",
  "tsconfig.json": "typescript",
  "deno.json": "typescript",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "setup.cfg": "python",
  "Pipfile": "python",
  "manage.py": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  // C family. A compile_commands.json is the strongest signal there is: it
  // means somebody set the project up for exactly the server we would start.
  "compile_commands.json": "cpp",
  "CMakeLists.txt": "cpp",
  "meson.build": "cpp",
  "Package.swift": "swift",
  Gemfile: "ruby",
  ".ruby-version": "ruby",
};

/** Extension → server id, for the counting half. */
const EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "typescript", jsx: "typescript", mjs: "typescript", cjs: "typescript",
  py: "python", pyi: "python",
  rs: "rust",
  go: "go",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  m: "cpp", mm: "cpp",
  swift: "swift",
  rb: "ruby", rake: "ruby",
};

/** Below this a language is incidental: one `.py` helper in a TypeScript repo
 *  should not put Python in front of anybody. A root manifest outranks it,
 *  being a deliberate statement rather than an accident of counting. */
const MIN_FILES = 3;

/**
 * Which languages this checkout is plausibly written in, strongest first.
 *
 * @param files paths relative to the checkout, as the file finder lists them.
 */
export function projectLanguages(files: readonly string[]): string[] {
  const score = new Map<string, number>();
  const bump = (server: string, by: number) =>
    score.set(server, (score.get(server) ?? 0) + by);

  const counts = new Map<string, number>();
  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    // A manifest at the ROOT is about the whole project. One nested inside is
    // usually a package, a fixture or a vendored dependency, so it is a
    // tiebreaker and nothing more: three real source files must outrank the
    // `package.json` that some fixture directory happens to contain.
    const marker = MARKERS[base];
    if (marker) bump(marker, file.includes("/") ? 1 : 40);

    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const server = EXTENSIONS[base.slice(dot + 1).toLowerCase()];
    if (server) counts.set(server, (counts.get(server) ?? 0) + 1);
  }

  for (const [server, n] of counts) {
    if (n >= MIN_FILES) bump(server, n);
  }

  return [...score.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([server]) => server);
}

/**
 * Which languages appear in this checkout AT ALL, strongest first.
 *
 * A laxer question than `projectLanguages`, for a different decision. Deciding
 * what to START without being asked has to be strict: one `.py` helper in a
 * TypeScript repo is not a reason to spend a few hundred megabytes. Deciding
 * what to OFFER is the opposite — a repo with a single `.ts` file in it is
 * exactly where someone might want to follow a symbol, and refusing to offer
 * because there are only two of them is a feature hiding from its user.
 *
 * What both refuse is a language that is not there. Offering "Enable Rust" on
 * a Django project asks the reader to evaluate something their checkout has no
 * trace of.
 */
export function languagesPresent(files: readonly string[]): string[] {
  const strong = projectLanguages(files);
  const seen = new Set(strong);
  const extra: string[] = [];
  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    const marker = MARKERS[base];
    if (marker && !seen.has(marker)) { seen.add(marker); extra.push(marker); }
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const server = EXTENSIONS[base.slice(dot + 1).toLowerCase()];
    if (server && !seen.has(server)) { seen.add(server); extra.push(server); }
  }
  return [...strong, ...extra];
}
