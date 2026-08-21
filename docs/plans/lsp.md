# Language servers (spec + findings)

**Approved** (GH #174, the code-navigation half; the commenting half shipped in
0.27.0). Opt-in, off by default, not started.

Code navigation via LSP: go-to-definition, find usages, hover types,
completion. Every number below was measured on a real repo, not quoted.

**Goal: navigate the code the agent is changing, in the task you are already
in.** Deliberately not "replace PyCharm" — that goal argues for owning rename,
refactors and the endless tail of "but PyCharm also does X", and it makes
phase 3 definitional rather than optional. What termic owes the user is the
ability to follow a symbol through the diff an agent just produced without
leaving the window.

Non-goal: becoming an IDE. Off by default, one process per language per task
at most, nothing bundled in the `.app`, nothing running until the user opts in.

## Why this is cheaper than it looks

Three pieces already exist:

- **`lintGutter()` is already mounted** (`EditorPane.tsx:240`) with no diagnostic
  source feeding it. It renders an empty gutter today. LSP diagnostics drop in.
- **Go-to-definition's landing half is already built.** `openPreviewTab(taskId,
  { type: "edit", path, revealAt: { line, col } })` (`store/app.ts:1794`) opens a
  file, jumps, centers, focuses. Find-in-Files drives it (`FindInFilesDialog.tsx:249`).
  An LSP definition response is the same call with different coordinates.
- **Compartments are the idiom** (`langCompRef`, `themeCompRef`). An `lspCompRef`
  toggles the feature live without rebuilding the `EditorView` (a rebuild re-reads
  disk and destroys undo history).

On the Rust side, `task_run_script_stream` (`lib.rs:6469`) already spawns a child
with piped stdio in its own process group and streams output to the webview. An
LSP host changes three things: keep `child.stdin` in managed state, swap
`BufReader::lines()` for a `Content-Length` framer, emit per-message.

## Measured data

Everything below was measured, not quoted. Blog-post figures for these servers
(300 MB to 4 GB) were wrong for our case by a wide margin.

### Python shootout

Repo: a real Django app. 982 MB total, of which a **938 MB `.venv`**; 58k lines
first-party; Django 5.0.9; Python 3.13. Symbol under test: a model class used
**309 times across 60 files** (three independent servers agree on that count).

| Server | Init | RSS idle | RSS after find-refs | Refs found | def → site-packages |
|---|---|---|---|---|---|
| **zuban 0.9.0** | 13 ms | 55 MB | **150 MB** | **309 / 60** ✓ | yes |
| **ty 0.0.59** | 10 ms | 51 MB | 246 MB | 251 / 59 ✗ | yes |
| basedpyright 1.39.9 | 172 ms | 415 MB | 451 MB | 310 / 60 ✓ | yes |
| pyrefly 1.1.1 | 25 ms | 472 MB | 477 MB | 309 / 60 ✓ | yes |
| pylsp 1.14.0 | 106 ms | 35 MB | 95 MB | 97 / 24 ✗✗ | **MISS** |
| jedi-ls 0.47.0 | 233 ms | 55 MB | 118 MB | 121 / 24 ✗✗ | **MISS** |

- `ruff server` adds **22 MB** and has **no navigation at all** (lint, format and
  code actions only; its hover only explains `noqa` codes). It is a second server,
  never the primary. This is widely misunderstood.
- **pylsp and jedi are disqualified**: neither resolves into `site-packages`.
- **ty missed a whole file** that contains a direct `from products.models import
  Product`. Its find-references is incomplete (251 vs the 309 consensus).

### Cost model

The August 2026 pass measured every server it could run. Two conclusions
replace what this section used to say.

**There is no single memory shape.** The doc previously generalised ty's
behaviour — cheap until find-references, then permanently expensive. That is one
of two patterns:

| Server | After opening a file | After workspace find-references |
|---|---|---|
| ty | 15-49 MB | 250 MB, never released |
| TypeScript 7 (termic, 307 files) | **276 MB** at project load | +1 MB, 9 ms — queries are free |
| rust-analyzer (termic `src-tauri`) | **3,184 MB** | (already paid at index) — 3,077 MB 20 s later |
| gopls (prometheus, 727 files) | 1,086 MB | **3,241 MB**, retained |
| gopls (kubernetes, 17.9k files) | 1,460 MB | **6,813 MB** → 5,112 MB after 60 s |
| clangd (abseil, 284k LOC) | — | **1,270 MB** peak |
| jdtls | ≥1 GB floor (`-Xms1G` hard-coded) | vendor default caps heap at 2 GB |
| Intelephense (Laravel, 3k files) | 394 MB | 479 MB |
| sourcekit-lsp | ~32 MB — but **fans out >ncpu `swift-frontend` children** | |

So TypeScript pays at project load and answers queries for free; Go, Python and
C++ pay on first find-references; Rust pays everything at index. All of them
**keep it** — rust-analyzer's LRU eviction is literally commented out in source,
and gopls and ty never shrink either. Killing the process remains the only way
to reclaim.

**The old "~800 MB worst case" was wrong by an order of magnitude.** A single
Go task on a large repo can exceed it six times over, and four Rust tasks on
termic's own `src-tauri` would reach 12 GB. Consequences for the lifecycle
policy below: the cap must be a **memory budget, not a count of three**, the
Activity window becomes the place this is visible and killable, and idle reap
matters more than it looks.

One thing that does NOT change: per-(task, language) is still required. Two
worktrees of one repo share module paths, so a shared server would resolve an
import into the wrong copy. That is a correctness bug, not a tuning knob, and
the memory cost is the price of it.

### TypeScript 7 (verified end to end)

TS 7.0 GA'd 2026-07-08 as a **native Go binary**. `tsserver.js` is gone from the
package. Verified on this machine: 9.27 MB download, SHA-256 matching GitHub's
release-API `digest`, `Mach-O 64-bit executable arm64`, **no
`com.apple.quarantine`**, runs as `Version 7.0.2`. Driven against termic's own
source: 13 ms init, 296 MB settled, correct semantic find-references.

Full TS/TSX navigation with **zero Node runtime**. This alone probably justifies
the subsystem.

## Architecture

```
CodeMirror  ──  @codemirror/lsp-client  ──  Transport  ──  Tauri Channel
                                                                │
                                                        Rust LSP host
                                                    (framing, lifecycle,
                                                     server→client replies)
                                                                │
                                                       child process (stdio)
```

**Frontend:** `@codemirror/lsp-client` (official, MIT, 6.2.5). Its transport is
three methods over raw JSON strings:

```ts
type Transport = {
  send(message: string): void
  subscribe(handler: (value: string) => void): void
  unsubscribe(handler: (value: string) => void): void
}
```

Docs: *"Messages should contain only the JSON messages, no LSP headers."* So
framing is Rust's problem and the adapter is ~30 lines. It is also the only CM6
client that implements `textDocument/references`; the community forks (Furqan,
marimo) do not, and find-usages is the whole point.

**Bridge:** a Tauri **`Channel`**, not `emit`/`listen`. Tauri's docs state event
listeners "may process events out of order if a listener is async". Out-of-order
delivery corrupts JSON-RPC.

**Backend:** `tokio::process` + hand-rolled `Content-Length` framing, ~200 lines,
which is what Helix, Lapce and Zed all do. Types from `gen-lsp-types` (0.10);
`lsp-types` has not shipped since June 2024 and rust-analyzer migrated off it in
June 2026. `tower-lsp` is for *writing* servers; not applicable.

No WebSocket, no localhost port, no daemon, **no CSP change** (all three are
forbidden by CLAUDE.md, and none is needed).

## The client contract

Thirteen servers were researched, one per language, each driven live where a
runtime was available. The single biggest finding is that **there is no such
thing as a generic LSP client here.** Servers disagree with each other on the
basics, and every disagreement below was observed, not read off a spec. Get
these wrong and the failure is silence or confident wrongness, never an error
dialog.

### 1. Answer server→client requests, and answer them in the exact shape

Not a dumb pipe. The rule is **advertise capabilities deliberately, then answer
everything you advertised** — most of these requests are only sent because the
client claimed to support something.

| Server | What an error/omitted reply does |
|---|---|
| pyright / basedpyright | **Process exits.** An error reply to `client/registerCapability` or `workspace/diagnostic/refresh` becomes an unhandled promise rejection and aborts Node. |
| ty | **Hangs forever.** Its `workspace/configuration` handler is the only thing that queues workspace init; every later request parks behind it. |
| ty | **Panics** if the config array length ≠ the number of requested items. Reply `[]` to a 1-item request → assertion failure and exit. |
| zls | Never resolves *any* config, including the path to `zig` — sits half-initialized. |
| TypeScript 7 | Deadlocks: the next `textDocument/diagnostic` hangs until timeout. |
| phpactor, Expert | `window/showMessageRequest` blocks find-references (10s soft, 60s hard) / blocks forever on an `:infinity` timeout. |

**The canonical reply to `workspace/configuration` is `[null]` — one `null` per
requested item.** That satisfies every server tested, sidesteps ty's panic and
its hang together, and means nothing has to be understood about the sections
being asked for.

`@codemirror/lsp-client` replies `-32601 MethodNotFound` to every
server-initiated request, so this must be fixed in our host regardless. That
same client bug is what made pyrefly return **9 references instead of 309**,
instantly and confidently — the failure mode this whole document is organised
around.

Cheapest posture: do NOT advertise `window.workDoneProgress` until we render
progress (pylsp blocks ~1s per linter per pass waiting for a reply we never
send), and do not advertise dynamic registration we do not implement.

### 2. Implement pull AND push diagnostics, and pick per server

Five distinct patterns across thirteen servers. There is no majority to code to:

- **Pull only** — TypeScript 7, Kotlin, ruby-lsp, Roslyn. A push-only client
  gets zero squiggles, silently. Roslyn additionally needs
  `textDocument.diagnostic.dynamicRegistration: true` advertised or it sends
  nothing at all.
- **Push only** — zls, Expert, jdtls, gopls (pull exists but is off by default),
  clangd, Intelephense, phpactor.
- **Dynamic** — sourcekit-lsp advertises no `diagnosticProvider` at
  `initialize`; it registers pull *after* the first `didOpen` and infers support
  from whether the client accepts the registration. Reject it and you silently
  drop to push.
- **Hybrid, both at once** — rust-analyzer advertises pull for its own
  diagnostics *and always pushes* `cargo check` results, ungated. **A pull-only
  client silently loses every compiler error.**
- **Conditional** — ty, zuban and ruff-server stop pushing the moment the client
  claims pull support. Claim it and you must actually poll it.

### 3. Send BOTH `rootUri` and `workspaceFolders`, and set the child's cwd

Servers disagree outright, and one of them treats it as fatal:

| Server | Reads |
|---|---|
| clangd | `rootUri` only — never looks at `workspaceFolders` |
| ruby-lsp | `workspaceFolders[0]` only — never reads `rootUri` |
| **phpactor** | **exits on startup** if `rootUri` is null |
| ty, ruff-server, pyright | ignore `rootUri` |
| jedi-ls | ignores `workspaceFolders` |
| rust-analyzer, ty, ruff-server | fall back to the **process cwd** |

So: always send both, and always spawn with `cwd` set to the task worktree.
Getting the last one wrong is not cosmetic — ty will index the user's entire
home directory (ty#2769), and rust-analyzer will index whatever directory
termic happened to be launched from.

Also handle `-32801 ContentModified` and retry: ty can drop an in-flight
references response if a `didOpen` races it (ty#3061).

### 4. Export the environment, and never sandbox a server

sourcekit-lsp's own client-authoring guide is explicit: *"don't attempt to use
SourceKit-LSP in a sandboxed context"* and *"provide the current system
environment variables … don't wipe them all out"*. That matches the decision in
[sandbox.md](../sandbox.md) — only the agent CLI PTY is in the threat model —
but it is now an upstream requirement rather than our preference. Python
additionally needs `VIRTUAL_ENV` exported: it is the only interpreter mechanism
every candidate except pyright honours.

### 5. Worktrees break servers that assume one project per machine

Three servers key state by something that collides across our worktrees:

- **jdtls** defaults its Eclipse workspace to
  `~/Library/Caches/jdtls/jdtls-<sha1(basename(cwd))>` — hashed over the
  **leaf directory name**, so two worktrees of the same repo silently share one
  index. Pass `-data` explicitly, per task.
- **Intelephense** defaults `storagePath` to `os.tmpdir()`; parallel tasks
  contend on one cache. Set it per worktree.
- **ruby-lsp** writes a *composed bundle* into `.ruby-lsp/` **in the project
  root** and runs `bundle install` there, so every worktree pays that cost on
  first start.

And **gopls relies on the client for file-change notification**: a branch
switch or an agent's rewrite that we do not report leaves it stale.

## Server registry: declarative manifests

Helix's format, not Zed's WASM.

A Zed language-server extension compiles a WASM module whose entire job is to
implement one function returning `{command, args, env}`. Measured cost of hosting
wasmtime: **+12.6 MB per architecture**, +171 crates, ~2x cold build. termic ships
a **15 MB universal .dmg** and links twice. That roughly doubles the app to run a
function that returns a command string.

It is also moot: our CSP is `script-src 'self'`. WASM in the webview needs
`wasm-unsafe-eval`; loading a third-party `@codemirror/lang-*` needs a wider
`script-src`. CLAUDE.md forbids widening the CSP. **So a webview-side extension
system is off the table by policy**, syntax highlighting stays compiled in, and
the only thing an extension can usefully carry is LSP wiring, which lives in Rust,
where a manifest is sufficient.

Sketch, compiled in, extensible via `~/.config/termic/languages/*.toml` (mirroring
the existing `~/.config/termic/themes/*.json` convention, so no new concepts):

```toml
id         = "python"
file-types = ["py", "pyi"]
roots      = ["pyproject.toml", "setup.py", ".git"]

[server]
command = "ty"
args    = ["server"]

[server.install]              # omit => PATH-only (Helix behaviour)
source = "github:astral-sh/ty"
version = "0.0.59"            # pinned
asset   = { darwin_arm64 = { file = "ty-aarch64-apple-darwin.tar.gz", sha256 = "..." } }
```

Adding rust-analyzer or gopls later is a data change, not a code change. Swapping
ty for zuban is one line.

### Resolution order

1. User override in Settings.
2. **Worktree-local** bins (`.venv/bin`, `node_modules/.bin`). Per-worktree, so a
   project's own toolchain wins. This is the step that makes it "just work" for
   users who already have one.
3. `PATH` (via `shell_env::resolved_path()` — a GUI-launched `.app` gets a bare
   PATH from launchd, so a server on `PATH` is invisible without it; see the
   comment at `lib.rs:1399`).
4. termic's own server dir (`~/Library/Application Support/termic/servers/<id>/`).
5. Otherwise prompt once: *"Python smart features need ty (18 MB). Download."*

Never install onto the user's `PATH`. Everything lands in a termic-owned directory
that can be deleted wholesale.

**Pin the version and the SHA-256 in the compiled-in manifest.** We are downloading
a binary and executing it against the user's source. Pinning turns "trust GitHub at
runtime" into "trust the termic release you already installed". Cheap now, expensive
to retrofit. Note most projects publish no `SHA256SUMS`; GitHub's release-API
per-asset `digest` field is the reliable source. Do not resolve `latest` at runtime.

## Lifecycle

Servers are keyed by **(resolved workspace root, language)** — NOT by task.

The distinction is worth real memory, because "one task, one root" is not true
in either direction:

- **Several tasks can share one root.** A main-checkout task (`is_main_checkout`)
  runs in the project's `root_path` itself, and nothing stops several existing at
  once. Same directory, same bytes, same branch — so N of them need **one**
  server between them, not N. At rust-analyzer's ~3.1 GB or gopls's 3-6 GB, that
  is the difference between a second main-checkout task being free and it costing
  another few gigabytes for an identical index.
- **One task can need several roots.** A multi-repo task holds several members,
  each with its own root (`kind: "host" | "worktree" | "repo_root"`), so it wants
  one server per member per language.

**Worktree tasks still get their own server, and that part is not negotiable.**
Two worktrees are different paths with *different content*, and they share module
paths — an import resolved in the wrong copy is a correctness bug, not a tuning
knob. That is the case the per-task memory cost is genuinely buying something.

Refcount, therefore: spawn on the first task that has code navigation enabled and
opens an editor tab of that language at that root; reap when the last such task
closes. Two consequences for the UI: turning navigation off in one task must not
kill a server another task is still using, and **"stop this server now" stops it
for every task sharing that root** — say so on the button rather than surprising
someone.

LSP's `workspaceFolders` (one server, many *unrelated* roots) is a different idea
and still not worth it: it saves only the process baseline, not the index, and it
couples task lifetimes and crashes.

Memory is therefore controlled by lifecycle:

- **Lazy spawn.** Only when an editor tab of that language is open in a task
  using that root.
  This fits termic unusually well: most of the time a task is open, the user is
  watching an agent in a terminal, not editing. The agent does not need the server.
  Six open tasks with no editor tabs cost zero.
- **Idle reap.** When the last editor tab of that language closes, shut down after
  a few minutes' grace. Tab bounces do not pay the restart; walking away frees the
  memory.
- **A memory budget, not a server count.** ~3 servers was sized against ty's
  250 MB. Measured reality spans 32 MB (sourcekit-lsp) to 6.8 GB (gopls on
  kubernetes), so the cap has to be RSS-aware: evict least-recently-used until
  the total is under budget, and refuse to spawn a new server when already over
  it. `rust-analyzer/memoryUsage` gives per-server RSS for free where supported.
- **Register in `cleanup_children`** (`lib.rs:8373`, wired to `RunEvent::Exit`).
  Forget this and rust-analyzer survives app quit and eats a core.

Steady state is 1-2 servers, because a human edits in one task at a time. The
worst case is no longer estimable as a single number — see the cost model above
— which is exactly why the budget is dynamic and surfaced in the Activity
window.

## Document model (prerequisite work)

There is **no document registry today**. Every editor tab creates a fresh
`EditorView` from a fresh disk read. Nothing tracks "what is open", no version
counter, nothing for `didOpen`/`didChange`/`didClose` to sync against.

**This phase is not "nothing visible".** It is the phase that has to be correct
or everything above it is quietly wrong, and wrong here does not raise errors,
it returns confident bad answers.

The trap: **`openPreviewTab` recycles a preview tab in place** (`store/app.ts`),
mutating the tab's `path` **without ever firing a close**. A naive tab-diff leaks
`didOpen`s and desyncs the server model, which produces wrong results rather than
errors. There is now precedent for exactly where the `didClose`/`didOpen` pair
belongs: that same recycle path already resets `syntax` / `syntaxAuto` because a
recycled slot is a DIFFERENT file (shipped in 9f8b487). Whatever it resets
there, the registry must close there.

Needed before any LSP code:

- A `(taskId, path) -> { version, languageId }` registry, driven by
  `openPreviewTab` / `closeTab` / the mount effect.
- **`languageId` comes from `lib/languages.ts`** — `effectiveLanguageId` is
  already the one place a language is decided, and it folds in the user's manual
  Set-syntax pick. Those ids are CodeMirror's registry NAMES ("Shell",
  "Properties files", "C++"), NOT the LSP spec's vocabulary, so the registry
  owns a small explicit name → LSP-`languageId` table (`Shell` →
  `shellscript`, `Properties files` → `ini`). See
  [docs/ui.md](../ui.md#which-language-and-where-that-is-decided). Note it is
  the PANE that resolves a path, not `lib/languages.ts`, which never sees one.
- **Decide what a URI-less buffer is.** Scratchpads (GH #244) are editor tabs
  with no path at all, so they either model as an untitled document or are
  excluded outright. Excluded is the right v1 answer — a language server has
  nothing useful to say about a note — but it has to be a decision, because the
  registry keys on path and a scratch tab would key on `undefined`.
- Forward the `ExternalReload` path too (`EditorPane.tsx:299`): a disk-change
  reload is a full-document `didChange`.
- Debounce `didChange`. It fires per keystroke.
- Extract `revealLine` (`EditorPane.tsx:112`, currently module-private) into a
  shared `gotoLocation()` so LSP jumps and Find-in-Files use one path.

## External files (the PyCharm-defining gap)

Today **every tab path is task-relative**, and `safe_task_path` (`lib.rs:5006`)
*rejects anything that escapes the worktree*, by design.

But ⌘-clicking `requests.get` must land in `site-packages/requests/api.py`. There
is currently **no tab type that can hold that file**.

Needs a read-only external-file tab: absolute path, no save, no dirty dot, not in
the file tree, plus an explicit read-only bypass of the containment check.

Phases 1-2 give nice navigation. **This phase is what makes it a PyCharm
replacement.** It is not optional for the stated goal.

## The hover surface is already partly claimed

Inline blame (shipped, see [ui.md](../ui.md)) shows its commit card as a CodeMirror
tooltip, so phase 1's hover no longer has the surface to itself. Blame does NOT use
`hoverTooltip`: it drives `showTooltip` from its own state field, opened by the
annotation's own `mouseenter` after a 1s delay and anchored at the line's end. So the
two can coexist without both registering a hover source and racing, but they can
still overlap on screen. The decision, so it is not discovered mid-implementation:

**Code hover and annotation hover stay separate, and only one card is ever on
screen.** Separation needs no arbitration — blame's annotation is a
`Decoration.widget({ side: 1 })` past `line.to`, where there is no symbol, so an
LSP `hoverTooltip` source returns null over it, and blame is not a hover source
at all. What DOES need a rule is both wanting the screen at once: a hover on a
symbol near the end of a line whose blame card is anchored at that line's end.
There, **hover wins** — hover is a question the user asked, blame is ambient.
Blame's card suppresses itself while an LSP tooltip is open on the same line;
its existing `cancelClose` / `closeCardSoon` lifecycle is where that hooks in.

## Security

- **Sanitize hover/completion HTML.** Servers return Markdown that gets rendered to
  HTML in the webview: an XSS channel from a process that reads the repo (including
  docstrings an agent just wrote). `@codemirror/lsp-client` exposes a `sanitizeHTML`
  hook; it must be set. `dompurify` is already a direct dep and `MarkdownPreview.tsx`
  already gates untrusted markdown. Same threat model as the remote-image gate (#69).
- **Do not sandbox the servers.** Consistent with the existing model: only the agent
  CLI PTY is in the threat model (see [sandbox.md](../sandbox.md)). A language server is
  the user's own toolchain, not the agent's. Deliberate, and worth stating.
- **Content-Length is bytes, not characters.** The classic hand-rolled-framer bug;
  it bites on the first non-ASCII docstring.

## Shipped manifests

One research pass per language, August 2026. Every row below has a named server,
a licence, and a reason for its tier. Sizes and memory figures are measured
unless marked otherwise.

The expensive part of supporting a language is **not the manifest, it is the
installer**: a manifest is a dozen lines of TOML, while an `[server.install]`
block is a pinned version plus a per-platform SHA-256 to re-pin on every
upstream release, and a claim that we tested that server.

### Tier 1 — we pin a version + SHA-256 and download it

| Language | Server | Licence | Download | Also needs |
|---|---|---|---|---|
| TypeScript / TSX / JS | **TypeScript 7** (`tsc --lsp --stdio`) | Apache-2.0 | 8.84 MB tarball, GitHub release, SHA-256 verified | nothing |
| Python | **ty** (nav) + **ruff server** (lint) | MIT | ~12 MB arm64 binary | nothing |
| Rust | **rust-analyzer** | MIT OR Apache-2.0 | 13.2 MB `.gz` → 35.7 MB binary, GitHub `digest` verified | the user's Rust toolchain (`cargo`, `rust-src`, `rust-analyzer-proc-macro-srv`) |
| C# | **Roslyn language server** | **MIT** | 66 MB `.nupkg` from nuget.org, immutable URL, SHA-256 verified | .NET 10 runtime **and** SDK on PATH |

Four traps that are conditions of shipping these, not footnotes:

- **TypeScript 7 is not one file.** The binary needs ~3 MB of sibling
  `lib.*.d.ts` (26 MB extracted). Ship only the executable and the CLI panics —
  but **LSP mode silently returns zero diagnostics**. Ship `package/lib/` whole.
- **rust-analyzer: never ship the rustup component.** It is dynamically linked
  against `librustc_driver` and `libLLVM`, which are not in its tarball; it only
  runs inside a toolchain tree. Use the standalone GitHub release, but probe
  `rustup which rust-analyzer` first and prefer it — a pinned build hard-rejects
  toolchains below its `MINIMUM_SUPPORTED_TOOLCHAIN_VERSION` (1.94 today, and it
  moves, so a pin we ship now will start refusing older toolchains over time).
- **C# is MIT via NuGet only.** The restrictive terms attach to the marketplace
  **VSIX** and to **C# Dev Kit** (usable only with Microsoft products). Take the
  NuGet package; never ship the VSIX; never touch Dev Kit. Its `--daemon-mode`
  escapes the process tree via `setsid` and conflicts with `cleanup_children` —
  opt-in at most.
- **ty's find-references needs re-verifying against the pinned build.** The
  earlier shootout in this doc measured ty 0.0.59 returning 251 of 309
  references; the August 2026 pass measured current ty as complete and
  workspace-wide. Both cannot be true of one version. Pin, re-run the Django
  case, and only enable find-references if the pinned build is correct — ship
  goto-def and hover regardless.

### Tier 1½ — probe the toolchain, then resolve a matching server

Neither a fixed pin nor PATH-only. Where the server is version-locked to a
compiler, the correct move is to read the toolchain version first and fetch the
server that matches it, SHA-verified from the official index.

**Zig** is the case that forced this category. `zls` is otherwise an ideal tier-1
candidate — 3.6 MB static binary, MIT, SHA-256s published at
`builds.zigtools.org/index.json` — but a tagged `zls` **hard-refuses nightly
Zig**, and much of the Zig community tracks master. A fixed pin would ship users
a server that rejects their compiler. (Today there is additionally no working
zls for Zig master at all, pending an upstream build-system rework.)

### Tier 2 — PATH-only manifests, no installer

Same format, no `[server.install]`. Present → we drive it. Absent → the language
has no navigation and we offer nothing.

| Language | Server | Licence | Why not tier 1 |
|---|---|---|---|
| Go | **gopls** | BSD-3 | **No official prebuilt binary exists** — every release has zero assets, `go install` is the only path — and it needs `go` on PATH at runtime anyway |
| Swift | **sourcekit-lsp** | Apache-2.0 w/ Runtime Library Exception | Toolchain-bundled; all 7 GitHub releases carry zero assets. It must match the user's `sourcekitd`, so pinning would break correctness rather than guarantee it |
| Java | **jdtls** | EPL-2.0 | A 48 MB OSGi/JVM app; the real dependency is a JDK 21+ we cannot ship (plus Python 3.9+ for its launcher) |
| Kotlin | **JetBrains `kotlin-lsp`** | Apache-2.0 source, proprietary parts in the binary | 370 MB, **Alpha**, and its builds **hard-expire on a timer** — a pinned SHA would become a scheduled outage. Homebrew avoids that and the Gatekeeper quarantine |
| C / C++ | **clangd** | Apache-2.0 w/ LLVM exception | 93.6 MB → 383 MB extracted, ~1.3 GB RSS, and without a compile DB it emits **fabricated errors inside libc++** |
| Ruby | **ruby-lsp** | MIT | A gem with a C extension, zero release assets; must run under the project's own Ruby and Bundler |
| PHP | **Intelephense**, else **phpactor** | proprietary EULA / MIT | Neither is a static binary, and neither runtime ships with macOS (**PHP was removed in Monterey**). See the licence note below |
| Elixir | **Expert** | Apache-2.0 | Prebuilt binaries exist, but it locates and compiles against the *project's* `elixir`/`erl`, so downloading buys nothing a PATH lookup does not |

Notes that belong in the UI, not just here:

- **Intelephense is proprietary, freemium, and phones home.** Its EULA
  *explicitly permits* an LSP client driving it, and goto-def / find-references /
  hover are free-tier (verified from a live `initialize`), so PATH-only use is
  legitimate. But §5(c) forbids redistribution, so **auto-downloading it would
  automate acceptance of a licence the user never sees** — the exact complaint
  filed against Helix. It also bundles Azure Application Insights telemetry,
  which contradicts termic's on-device claim unless we say so plainly. Prefer it
  when present, fall back to **phpactor** (MIT) otherwise, and label both.
- **Swift navigation needs a build server.** `.xcodeproj` / `.xcworkspace` are
  **not supported at all** — zero occurrences in sourcekit-lsp's tree. Cross-file
  goto-def in a bare directory returns `null`. Users need `Package.swift`, or a
  bridge like `xcode-build-server` producing `buildServer.json`. Say so rather
  than shipping a server that looks broken.
- **Detecting Swift is not a PATH lookup.** `/usr/bin/sourcekit-lsp` is a 116 KB
  xcselect **shim** that exists on a Mac with no developer tools and pops an
  installer dialog when exec'd. Probe `xcode-select -p` (exit 0 **and** the
  directory exists), then `xcrun --find sourcekit-lsp`. Command Line Tools alone
  is sufficient — Xcode is not required.
- **`/usr/bin/java` proves nothing** either; bare macOS ships a stub. Detect via
  `/usr/libexec/java_home -v 21+`.

### Skipped, with reasons

- **JSON, Markdown, HTML/CSS** — CodeMirror already wins in-process. A
  subprocess to report a misspelled JSON key is a bad trade.
- **bash** — weak servers, thin payoff.
- **Microsoft cpptools** — **licence forbids it.** Usable "only with" Microsoft
  products, and redistribution as a stand-alone offering is prohibited. Not even
  tier 2.
- **C# Dev Kit** — proprietary, Microsoft-editors-only. Not needed: the Roslyn
  server asserts `isUsingDevKit == false` on the path we use.
- **Dead projects**, named so nobody re-proposes them: `fwcd/kotlin-language-server`
  (deprecated by its own author in favour of JetBrains'), **OmniSharp** (no
  release since Nov 2025, dropped by vscode-csharp), `lexical` and `next-ls`
  (both archived; next-ls redirects to Expert), `felixfbecker/php-language-server`
  (dead since 2018), `sourcegraph/go-langserver` (archived 2022).
- **Watch, do not ship**: `kmp-lsp` (Rust, Kotlin, no type checking), `Dexter`
  (Go, Elixir, no BEAM needed), `Mago` and `phpantom_lsp` (PHP, Rust). All under
  a year old. Re-evaluate in six months.

### Python server choice, honestly

## Phasing

| Phase | Work | Ships |
|---|---|---|
| 0 | Document registry; extract `gotoLocation()` | nothing visible; unblocks all |
| 1 | Rust LSP host + Channel transport + TypeScript 7 AND Python, default-OFF pref | hover, diagnostics, goto-def |
| 2 | Find-references panel, completion, signature help, rename | the PyCharm core |
| 3 | Read-only external-file tabs | ⌘-click into site-packages |
| 4 | Declarative manifests + Settings section | tier 1 completed (rust-analyzer, Roslyn) AND the whole tier-2 PATH-only set (Go, Swift, Java, Kotlin, C/C++, Ruby, PHP, Elixir) + Zig via toolchain probe |
| 5 | `[server.install]` download with pinned checksums | works without a toolchain |

Value is concentrated in 0-2, which is the whole of the stated goal. Phase 3
buys ⌘-click into dependency source; it is worth doing and it is not what the
feature is for, so it does not gate calling this done.

**Phase 1 ships TypeScript 7 and Python together.** TS7 is the strongest
measured case and needs no runtime, it is dogfooded in this repo every day, and
it does not depend on settling ty vs zuban. Python ships alongside it with
goto-def and hover only (see the Python section: no find-references until a
server earns it), so the open question below blocks a feature, not the phase.

## Opt-in: "Code navigation"

Three levels, each **inheriting** from the one above, all machine-local. This is
the shape sandbox already uses (app default → project → per-task override), so
it is a familiar control rather than a new concept.

- **An app-wide pref, default OFF** (`prefs.ts`, alongside `loadRemoteImages`).
  The master switch, and the answer to "why would I spend RAM on a repo I only
  ever point agents at".
- **A per-project override** on the `Project` record (`projects.json`),
  tri-state inherit / on / off, next to `default_sandbox` and
  `spotlight_enabled`. Navigation on for the repo you read, off for the four you
  only supervise.
- **A per-task override**, same tri-state, defaulting to inherit.

**Why per-task, given the cost model.** An earlier draft rejected it, on the
grounds that tasks are created constantly so a per-task switch would mean
re-enabling this several times a day. That objection only holds if the per-task
level is a *required choice*; as an override that defaults to inherit, the
common path costs the user nothing and the control exists when it matters.

And it matters more than the draft assumed, because the unit of memory is the
TASK, not the project. Measured: rust-analyzer holds ~3.1 GB per worktree and
gopls up to 6.8 GB, neither ever released. Six tasks on one repo where the user
reads code in exactly one of them is the normal case in termic, and a
project-level switch cannot express it — it is all six or none. The per-task
override is the only level that matches where the cost is actually incurred.

It is also the natural home for **"stop this server now"**: the same control
that says "not this task" reclaims gigabytes immediately, which pairs with
listing servers in the Activity window.

**Per-task is the RECOMMENDED level, and the UI should say so.** App-wide on is
the setting most likely to surprise someone: it arms every task in every project,
and the bill only arrives later, from a process the user never started. Steering
people to enable navigation in the one task they are reading code in is both the
cheapest default and the honest one.

### The memory disclosure is part of the feature

A user cannot consent to a cost nobody showed them, and this cost is large,
per-worktree, and never reclaimed until the process dies. Three things have to be
said at the moment of enabling — not buried in Settings:

1. **A number, from the manifest, per language.** Not "may use significant
   memory". Each manifest carries a measured typical and worst-case RSS, so the
   toggle can read *"rust-analyzer typically holds 2-3 GB per task and does not
   release it"* or *"gopls 1 GB, up to 7 GB on a large repo"*. The figures in the
   cost model above are the seed values.
2. **That the unit is the worktree, not the project.** Users reasonably assume
   one server per repo, the way an IDE works. Termic is not that: every worktree
   task is a separate checkout with different content, so it needs its own
   server and its own copy of the index. Ten tasks on one repo with navigation on
   everywhere is ten indexes. The exception is worth stating in the same breath —
   several main-checkout tasks share one root and therefore one server.
3. **Where it went and how to get it back.** The Activity window lists live
   servers with their RSS and a stop button; stopping one frees its memory
   immediately and costs a re-index when next needed.

Language servers are the first thing termic runs that can cost more than every
agent in the window combined. That deserves a sentence at the point of decision,
not a support thread afterwards.

**Deliberately NOT in `.termic.yaml`.** The repo config is committed and
team-shared, which is right for sandbox policy and wrong for this: whether to
spend 250 MB of *this* machine's memory is a personal choice, not something a
colleague decides for you by pushing a config change.

The label is **"Code navigation"**, not "smart code features" — it names what
you get (go to definition, find usages, hover types) instead of inviting "smart
how?". The roadmap's broader "code intelligence" stays as the name of the whole
subsystem.

**The toggle grants permission; it does not start anything.** Even fully on,
nothing spawns until an editor tab of that language is open in that task —
watching an agent in a terminal costs zero, which is what most tasks are doing
most of the time. With the switch off, nothing spawns, nothing is imported, and
the editor is byte-for-byte what it is today.

Discovery should not depend on browsing Settings: prompt contextually in the
editor the first time it would help.

## Open questions

- ty vs zuban as the Python default. Both are single Rust binaries speaking the same
  protocol, so the manifest makes it a one-line swap. Decide by running both against
  real repos, not on paper.
- Whether a Tauri/`reqwest` download path stamps `com.apple.quarantine` (a `curl`
  download does not; verified). If it does, strip it after hash verification, as
  Homebrew and pnpm do. **Check empirically before designing around it.**
- Whether to bundle any server. Current answer: no. Bundling ~4 servers universal is
  roughly +100 MB on a 15 MB app, and walks into Tauri's macOS sidecar signing bug
  (tauri#11992).
