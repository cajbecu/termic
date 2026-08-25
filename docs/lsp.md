# Language servers: the rules a new one has to obey

Everything in this file was paid for by a bug. It is the reference for adding
or changing a language server in termic, and the short version is: **no two
servers agree about anything, so the client has to do the work.**

Where things live:

```
src-tauri/src/lib.rs      spawn, framing, resolution, install, server→client replies
src/lib/lsp/host.ts       one client per (checkout, server), grants, reap
src/lib/lsp/*.ts          the features (symbols, usages, declaration hop, …)
src/components/…/CodeIntelChip.tsx      the one place it is turned on
src/components/settings/CodeIntelSettings.tsx   how a user configures a server
```

## Adding a server: the checklist

1. Add it to `lsp_resolve_server` in `lib.rs`, **project-local before PATH**.
   A repo that pins its own toolchain must win over anything global.
2. If it can be downloaded, add an `LspInstall` entry: pinned version, pinned
   SHA-256, verified before anything is unpacked or run. If upstream ships no
   binary, it does not automatically stay PATH-only: work out WHY first.

   - **gopls** publishes no binaries and needs the Go toolchain at run time
     anyway, so it is genuinely PATH-only.
   - **zuban** is dual licensed AGPL-3.0 / commercial. termic is
     AGPL-3.0-or-later, so the open-source half is compatible and an earlier
     version of this file was wrong to call it a redistribution problem. What
     actually stops it being bundled is that it ships as a PyPI wheel: it needs
     a Python interpreter, which only the user's machine has. `lsp_install_zuban`
     therefore builds a virtualenv termic owns (`uv venv`, falling back to
     `python3 -m venv`), on a button, never silently. Nothing touches the
     project's environment or the user's PATH.

   The rule the two cases share: say which it is, in the row, and never install
   anything the user did not ask for.
3. Add it to `lsp_catalog` too. That command is what Settings lists, and it is
   a SECOND copy of the resolution order in `lsp_resolve_server`: the one thing
   in this subsystem that can silently drift. A server missing from it is a
   server nobody can see they have.
4. Add a `ServerGuide` in `lib/lsp/serverSettings.ts`: what it is, which files
   in the repo it reads, which environment variables it honours, its docs URL,
   and **which channel a raw settings block has to go down** (see rule 6).
5. Add a memory figure to `MEMORY_NOTE` in `lib/lsp/serverNames.ts` (and the
   one-line `MEMORY_SHORT` beside it). Measure it, do not estimate it:
   `scratchpad/lsp-probe.mjs` prints RSS. Then run the server against a scratch
   checkout and `ls -a` it: anything new that appears goes in the same note
   (rule 18).
6. Record a `workspace/symbol` answer as a fixture and add it to
   `symbolSearch.realservers.test.ts`. Every server has behaved differently
   here, every time.
7. Add a fixture project under `e2e/fixtures/lsp-projects/<language>` and a
   `CASES` entry in `scripts/lsp-smoke.mjs`, then run `make lsp-smoke`. The
   fixture defines a symbol in one file and uses it in another, which is what
   makes the definition check mean anything. Ignore whatever the server writes
   into it (rule 18).
8. Then use it against a REAL project and check hover, definition, diagnostics
   and symbols before believing any of it.

## What termic serves, and where each server comes from

| Language | Server | Where it comes from |
|---|---|---|
| TypeScript, JavaScript, TSX | tsgo (TypeScript 7) | repo's `node_modules`, PATH, then termic's pinned download |
| Python | zuban → ty → basedpyright | repo's `.venv`, PATH, then termic's own virtualenv (zuban) or download (ty) |
| Rust | rust-analyzer | `rustup which`, PATH, then termic's pinned download |
| Go | gopls | PATH only (upstream ships no binaries, and it needs the toolchain anyway) |
| C, C++, Objective-C | clangd | PATH. **Already on every Mac** with the Command Line Tools; `apt install clangd` on Linux, where the binary is versioned (`clangd-18`) so resolution tries those too |
| Swift | sourcekit-lsp | PATH. Ships with the Command Line Tools on macOS and the Swift toolchain on Linux |
| Ruby | ruby-lsp | the project's `bin/ruby-lsp` binstub first, then PATH |

The last three cost nothing to install on macOS and are one package on Linux,
which is why they are PATH-only rather than downloads: an `LspInstall` entry
that duplicates a binary the machine already has is a liability, not a feature.

Each was proved end to end against the real server before shipping, on a
fixture in `e2e/fixtures/lsp-projects/<language>`: see "Proving it against real
servers" below. What that flushed out is rules 18 and 19.

## The rules

### 1. Name the server that will actually run, never the language

A language is not a server. Python resolves zuban → ty → basedpyright, and for
a while the chip said "ty" above a process that was zuban, with ty's memory
figure underneath it. Anything user-visible derives from the resolved
executable path (`serverFor`), not from a table keyed by language.

### 2. `workspace/configuration` must answer one entry per requested item, and never `{}`

ty asserts on the length and exits when it does not match. A blanket `[]` or a
single `null` is not a safe general answer. Answer `null` per item when there
is no opinion, and never `{}`: a server handed an empty object where it
expected null may read it as a real, empty configuration.

The frontend always sends an object, so `lsp_start` normalises an EMPTY
settings object back to null before anything is answered. Without that the rule
was broken on the default path, and every Rust test passed `Null`, which is a
value production never produced.

### 3. Never reply with an error to a server→client request

`client/registerCapability`, `window/workDoneProgress/create`,
`workspace/*Refresh`, `window/showMessageRequest`: a `null` result is accepted
by all of them. An error reply aborts pyright's Node process, and no reply at
all leaves find-references hanging behind a 60s timeout.

### 4. Claim only the diagnostics model we implement

The CodeMirror client advertises `textDocument.diagnostic` (pull) and then
implements push only. ty, zuban and ruff-server stop pushing the moment a
client claims pull, so the editor showed nothing at all, with no error
anywhere: measured 0 diagnostics with the claim, 2 without. The host strips
the claim in `lsp_patch_initialize`, and `pullDiagnostics.ts` polls the
servers that advertise a provider. Claim what we do, poll what they offer.

### 5. Python interpreters are found three different ways

`VIRTUAL_ENV` in the environment covers zuban and ty. pyright and basedpyright
ignore it entirely and take `python.pythonPath` from the configuration reply.
Get it wrong and every third-party import is unresolved, which reads as "this
feature is broken" rather than "it is looking at the wrong Python".

### 5a. A language server gets PATH, not your secrets

`shell_env::spawn_env()` is the login-shell delta, and it is how an agent CLI
receives its `ANTHROPIC_API_KEY`. A language server is resolved from INSIDE the
checkout first (`node_modules/.bin/tsgo`, `.venv/bin/zuban`), so a cloned repo
chooses the process, and it runs uncaged with the network. `lsp_start`
therefore filters that delta to an allowlist: the virtualenv, the toolchain
pointers, locale. Adding a variable there is adding it to something a hostile
repo can read.

### 6. A settings block sent down the wrong channel is accepted and ignored

rust-analyzer and zuban read their configuration from
`initializationOptions`; gopls and ty only ever pull it via
`workspace/configuration`. There is no error either way, which makes this the
most expensive kind of wrong. `ServerGuide.rawChannel` records which, and
`resolveServerSettings` routes on it. When termic does not know a server, the
safe default is settings: every server implements that channel, and an unknown
key there is ignored rather than fatal.

### 7. termic does not translate anyone's settings

A friendly-toggles screen that maps onto each server's keys was built and
thrown away. zuban takes `typeCheckingMode` at init, ty takes
`ty.diagnosticMode` as a pulled setting, basedpyright takes
`python.analysis.diagnosticMode`, and they do not agree on how to spell the
same value (`open-files-only` against `openFilesOnly`). Three servers, one
language, three dialects, all moving. A mapping table is a second, staler copy
of five projects' documentation.

What a person needs instead is the truth, once: **this server runs, this file
in your repo configures it, here are its docs.** Almost every server takes its
real configuration from a committed file (`pyproject.toml`,
`pyrightconfig.json`, `tsconfig.json`, `rust-analyzer.toml`), which is
team-shared and works in every other editor those people use. The raw JSON box
is the escape hatch for what only exists over LSP, forwarded verbatim and
never validated: the server owns its own schema and says so in its own log.

### 8. Settings are read once, at spawn

`initializationOptions` is part of `initialize`, and a pulled configuration is
answered from what the process was spawned with. Editing settings changes
nothing about a running server, so the UI says so and offers a restart. It is
a button, not automatic: the box saves on a 500ms debounce while you are still
typing, and a server that respawned on every pause would reindex the repo
several times per sentence.

### 9. Case is the client's problem

Measured on a real project: zuban answers `AISetup` with 26 symbols and
`AiSetup` with **zero**, while gopls and rust-analyzer fold case and match
camel humps (`SB` finds `StoreByID`, `LsSrv` finds `LspServer`). The same
keystrokes gave a full list or an empty one depending on the language of the
file.

`serverQueries` therefore asks for the exact query **plus every casing of its
first two characters**: any name containing `aisetup` in some casing contains
`ai` in some casing, so that is a superset the client can narrow. It costs
26-28ms per query, the same as the precise one, because the work is in the
index either way. The exact query goes too, because servers cap what they
return for a broad one.

### 10. An import site is not a definition

`workspace/symbol` returns the binding an `import` creates, because that
binding genuinely is a symbol and nothing in the protocol marks it. Asking
zuban for `Store` in a Django project returns 95 symbols: 31 classes and 64
`from stores.models import Store` lines. tsgo does the same for a
`const X = lazy(() => import(…))`. Ranked by name alone the imports tied with
the class and beat it on the tiebreak, so a search for a class that existed
showed 25 rows of imports and not the class.

`preferDefinitions` drops a name's binding-kind hits when that name is defined
somewhere in the answer, and keeps them when it is not (a constant, or
something from a dependency the server cannot see into, where the import site
is the only place to go).

### 11. Follow a declaration to its source

Servers resolve imports through type stubs, so ⌘-clicking a Django model lands
in `django-stubs/db/models/base.pyi`, a file of signatures with `...` for every
body. Correct answer to "what is the type", wrong answer to "show me this
code". `declarationSource.ts` hops `.pyi` → `.py` and `.d.ts` → source, and it
only accepts **definition-shaped** lines: an earlier version fell back to any
mention of the word and landed on `if any(f.name == "objects" …)`, which is a
coincidence, not an answer.

### 12. The unit is the checkout, and that is correctness

Tasks sharing a checkout share one server. Two worktrees of one repo must NOT,
because they hold different content behind the same module paths and a shared
server would resolve an import into the wrong copy. `checkoutRoot()` is the
one place that decides which is which.

### 13. Nothing loads until a checkout is armed

`mainChunkGuard.test.ts` forbids `@codemirror/lsp-client`, `lib/lsp/host` and
`lib/lsp/editorExtension` from the app-start graph. Anything in the main chunk
that needs the host (Settings, the Search Everywhere dialog) must reach it
through a dynamic `await import("@/lib/lsp/host")`.

### 14. Whatever starts a server discloses what it costs, or is capped

rust-analyzer holds ~3 GB on this repo's own `src-tauri`; gopls has been
measured at 6.8 GB; zuban at 86 MB on a Django project. "May use significant
memory" is not consent. The figure is quoted before the first arm, once, with
a don't-ask-again.

The path that does NOT ask is `autoStart`, because a standing instruction is
consent already given. That is why it is capped (`AUTO_START_CAP`): four
languages across ten worktrees plans forty servers, which the figures above put
near 100 GB, and nothing else bounded it. The cap does not make that a good
idea; it stops the app being the thing that did it silently. Arming by hand is
uncapped, because that path shows the number every time.

### 15. Say when the environment, not the server, is the problem

A Django project without `django-stubs` lights up every model query in red,
because Django installs `objects` at runtime and a checker reading the source
is correct to say it is missing. The app says which it is (`lsp_offer`'s
caveat) and does NOT install anything: the project's environment is the
project's.

The same shape, found later on a WXT extension: `defineBackground` reported as
an undefined name on the line that used it, in code that builds. TypeScript
finds a project by walking UP from the file, and that repo's only
`tsconfig.json` was the generated `.wxt/tsconfig.json` in a sibling directory,
so the server found no project at all and read every file on its own: no path
aliases, and none of the ambient `.d.ts` the framework generates.
`typescript_without_tsconfig` says so and names the fix. Nuxt (`.nuxt`) and
SvelteKit (`.svelte-kit`) have the identical trap, and all three directories
are gitignored, so a fresh worktree has neither the config nor the types.

Only add a detector for a failure you have SEEN, and write it in the words the
reader would use. A table of speculative warnings trains people to dismiss the
one that matters.

### 16. Type checking is opt-in; navigation is the product

`prefs.codeIntelDiagnostics` ships OFF. Three real projects argued for it in
one afternoon: a Django repo without django-stubs underlining every model
query, zuban calling a third-party admin widget's types an error, and a WXT
extension reporting its own generated globals as undefined. Each is the
environment rather than the code, each needs its own configuration to silence,
and none of them helps you follow a symbol through a diff an agent just wrote.

Turning it off costs nothing else: hover, definition, usages, the outline,
Search Everywhere and completion come from the same server and are unaffected.

Both diagnostic models go through `lib/lsp/diagnosticsSink.ts`, which is also
what makes the switch honest in both directions: turning it ON re-applies what
a PUSHING server already said, instead of leaving the file clean until the next
keystroke. The pull path additionally stops asking, because an unasked server
spends no CPU.

The Settings toggle carries an **Experimental** badge, and that is a statement
about where this stands, not a disclaimer to leave on forever. Navigation
answers the same on every project we have tried. Type checking does not,
because it is not really one feature: it is whatever the project's own checker
config says it is, and most projects have never written one.

### 16a. Most "false positives" are the checker being right about a library

The shape that keeps coming back, from a real `django-unfold` admin (and
reproducible in thirteen lines with no framework at all):

```python
class Base:
    overrides = {F1: {"widget": W1()}}      # no annotation: type INFERRED

class Sub(Base):
    overrides = {F1: {"widget": W1()}, F3: {"widget": W3()}}
    # error: Incompatible types in assignment ... base class "Base" defined
    #        the type as "dict[type[F1], dict[str, W1]]"  [assignment]
```

The base class never annotated the attribute, so mypy semantics infer its type
from that one literal, and `dict` is invariant, so no subclass can assign a
different one. PyCharm stays quiet because its checker is far more permissive
about attribute overrides, which is why "PyCharm does not complain" is not
evidence the underline is wrong. zuban is mypy-compatible; this is mypy being
mypy, on a library that did not annotate for it.

We cannot fix that class of thing, and must not try to. What we owe the user is
the **handle**, and that is the rule id: `[assignment]` is literally the
argument to both ways of silencing it. `lib/lsp/diagnosticMap.ts` puts it in
the tooltip next to the server name ("zuban [assignment]") for BOTH delivery
models; the code used to be dropped, and the push path did not even carry the
server name.

Three levers, all verified against zuban 0.9.1 on this repro, in order of how
right they are:

1. **Annotate it upstream** (`overrides: dict[type[Any], dict[str, Any]]`).
   Fixes it for every subclass and everybody else's checkout. Send the PR.
2. **`# type: ignore[assignment]`** on the line. Narrow, local, and it names
   the exact rule, so an unrelated error on that line still surfaces. zuban
   even tells you when the code you wrote does not cover the error it found.
3. **`disable_error_code` in the project's mypy config**, whole-project in
   `[tool.mypy]` or scoped per module in `mypy.ini`. zuban reads both, and it
   reads them from the CHECKOUT ROOT, which is where we spawn it (rule 12), so
   a config a colleague committed already applies with no termic setting at
   all. That is the answer to "how do I tune this", and it is the project's
   file, not ours (rule 7).

### 16b. The reader picks the server, not just its settings

Python resolves zuban -> ty -> basedpyright and TypeScript resolves tsgo ->
typescript-language-server. Both orders are right often enough to be defaults
and wrong often enough that somebody has to be able to say so: the Django
afternoon's real fix was not a setting, it was a different process, and there
was no way to ask for one.

Settings -> Editor -> Servers puts a radio on each row of a language that has
more than one, plus **Automatic** for termic's order, and a **Custom command**
field on every language for a binary termic does not ship at all (pylsp,
pyright-langserver, a wrapper script in the repo). Both exist per machine and
per project; a project overrides the machine because it is the narrower
statement ("this repo needs pyright" beats "on this laptop I like zuban").

Precedence, most explicit to least: project command, project pick, machine
command, machine pick, termic's order. `serverChoiceFor` in
`lib/lsp/serverChoice.ts` is the only place that decides it.

The command is run WITHOUT a shell (`split_command_line` in `lib.rs`): the
string comes from a settings field, and `sh -c` would make every stray `;`
executable. Whitespace separates arguments and quotes group them; a relative
path resolves against the checkout, so a script committed to the repo works.

Five things make it honest:

- **The pick reaches BOTH commands.** `lsp_start` and `lsp_offer` each take
  `preferred`, because the offer describes the process that will actually
  start; sending it to only one is how the chip names one server while another
  runs (rule 1).
- **A pick is a preference, not an assertion.** A pick that resolves to nothing
  on this machine falls through to the normal order, so the reader who chose
  basedpyright and then opened a laptop without it still gets navigation.
- **A typed command is an assertion**, and is NOT probed first. If it is wrong
  the reader has to see it fail, rather than have termic quietly run something
  else and leave them wondering why their settings did nothing.
- **A repo-local copy still wins.** `node_modules/.bin/tsgo` and `.venv/bin/ty`
  are the project pinning its own toolchain, which outranks a machine-wide
  taste (rule 12's reasoning: the unit is the checkout).
- **Choosing stops what is running.** `stopClientsForLanguage` runs on the
  click, or the old process keeps answering and the setting appears to do
  nothing until the next relaunch. Grants survive, so the next editor open
  starts the new binary without asking for consent again.

Machine-local (`prefs`), deliberately not in the project: whether this machine
runs zuban or basedpyright is not a colleague's decision, and it usually
follows what the person has installed. The value is mirrored into
`lib/lsp/serverChoice.ts` for the same reason `diagnosticsPref.ts` exists:
`install.ts` is reached from node-environment tests and `prefs.ts` touches the
DOM at import.

### 17. A page reload orphans every running server, and the host must sweep them

Found on a dev machine, not in a test: **six live `tsgo` processes, all on the
same checkout**, spawned minutes apart, about 300 MB each. One server per
(checkout, language) is the design, and the map that enforces it lives in the
WEBVIEW (`lib/lsp/host.ts`). A reload throws that map away, so the fresh page
starts its own server while the previous one keeps running, unreachable
forever: its `Channel` died with the page that made it, so nothing can send to
it and it will never answer anyone again.

Reloads are routine here: ⌘R, an HMR full reload during development, a renderer
crash. An afternoon of editing files with the app open is how six of them
accumulate.

`lsp_start`'s reader thread DOES notice a dead Channel and kill its child, but
only when the server next SENDS something, and an idle server sends nothing.
That check is necessary and nowhere near sufficient.

So each page load stamps the servers it starts (`LSP_PAGE_ID` in
`lib/lsp/pageSession.ts`, a fresh UUID per load, never persisted), and calls
`lsp_reap_foreign` once at app start to kill everything stamped otherwise. Two
details that are the design rather than the implementation:

- **At startup, not on the next arm.** The orphans exist whether or not this
  session ever turns code intelligence on, and nobody is coming back for them.
  That is also why `pageSession.ts` is a tiny module with no LSP imports:
  `lib/lsp/host` is forbidden on the app-start path (`mainChunkGuard.test.ts`).
- **A server with no stamp is left alone.** An older frontend then leaks
  exactly as it did before, rather than having its live servers killed by a
  newer page that cannot tell them apart. Leaking is the safer way to be wrong.

Quitting the app was never the problem: `cleanup_on_exit` already SIGKILLs the
group of every registered server.

### 18. A server that writes into the checkout has to say so before it starts

Three of the seven do, and none of it is in the protocol:

- **clangd** writes its background index to `<checkout>/.cache/clangd`. Without
  `--background-index` it answers find-usages from the open translation unit
  and looks broken, so the flag is not optional; the write is the price.
- **ruby-lsp** writes `<checkout>/.ruby-lsp` for the bundle it runs under.
- **sourcekit-lsp** reads the index the compiler wrote into `.build`, so it
  answers about one file until the package has been built once.

An agent running `git add -A` in that worktree is how this becomes the user's
problem, so the disclosure that already quotes the memory figure quotes the
disk write too (`MEMORY_NOTE` in `lib/lsp/serverNames.ts`). Both halves were
CONFIRMED by running the servers against the fixtures and looking at what
appeared, not read off a docs page.

The general form: before adding a server, run it against a scratch checkout
and `ls -a` afterwards. If something new is there, it goes in the note.

### 19. Some servers refuse rather than degrade, and the message never reaches the user

ruby-lsp on a Gemfile with no `Gemfile.lock` prints one line to stderr and
exits, before answering `initialize`. From inside the app that is
indistinguishable from a server that failed to start, and the fix is one
command. `lsp_offer` therefore carries `ruby_without_lockfile`, next to
`django_without_stubs`, `typescript_without_tsconfig`,
`cpp_without_compile_commands` and `swift_without_a_build`.

The quieter version of the same thing is a server that starts, answers, and is
missing most of what it should know: clangd with no compilation database,
sourcekit-lsp against a package that was never built. Nothing is broken, so
nothing reports an error, and the user concludes the feature does not work.

All five follow rule 15's bar: each was observed on a real checkout, and each
is described in the words the reader would use, with the command that ends it.

## What is deliberately not built

The plan this file replaced (`docs/plans/lsp.md`, deleted when the work
shipped) listed four things that are still absent. Three are choices rather
than gaps:

- **A registry for a language termic does not serve.** Adding an eighth
  language (Elixir, PHP, Java, Zig) means a new slot: extensions, an LSP
  `languageId`, project-detection markers, a display name, a memory figure and
  a catalog row. Parked on purpose. Nobody has asked, detection is something we
  would rather own than delegate, and the escape hatch below covers the
  complaint people actually have. See [ideas/lsp-tuning.md](ideas/lsp-tuning.md).
- **Rename.** Editing across files from an editor that is a reading surface,
  next to an agent that is already editing those files, is a collision waiting
  to happen. Navigation is the product (rule 16).
- **An RSS-aware cap** that evicts the least recently used server. The
  lifecycle bounds servers a different way (one per checkout per language,
  refcounted, reaped three minutes after the last editor closes), and the cost
  is disclosed before anything starts. A cap would be the second mechanism for
  a problem the first one has not yet been observed to miss.

What IS covered instead: a custom command per language (rule 16b), which runs
any binary the reader names for one of the seven languages. That is the
difference between "I want pylsp" (supported) and "I write Elixir" (not).

## Proving it against real servers

`make lsp-smoke` drives the actual servers on this machine against tiny fixture
projects in `e2e/fixtures/lsp-projects`, one per language, and checks the
things that break silently: resolution, hover, a definition that crosses files,
`workspace/symbol` finding the definition, a deliberately broken file producing
diagnostics, and an undefined name being named.

It is **local only and never CI**, by design: it needs the real toolchains, and
a runner has none of them. Nothing it does gates a merge. Run it when a server
is upgraded, before a release, or on a timer:

```sh
make lsp-smoke                    # everything this machine can serve
make lsp-smoke LANG_ONLY=python   # one language
make lsp-smoke-record             # refresh the recorded symbol answers
```

A server this machine does not have is reported, not failed. A smoke run that
always fails is a run nobody makes.

Two things the harness has to do that a reader would not guess:

- **The symbol query is retried** for up to 30s. clangd (and rust-analyzer)
  answer `workspace/symbol` from an index built in the background, and until it
  is ready they answer `[]` rather than waiting. Asking once reported "0
  answers" for a server that works. It is the same race a user hits by pressing
  double-shift the moment they arm a checkout.
- **Fixtures have a `prepare` step**, because two of them cannot be answered
  about as committed: clangd needs a `compile_commands.json` whose every path
  is absolute (generated, never committed), and sourcekit-lsp needs the package
  built once. Both are the first-run cost a real user pays too.

All seven languages pass here as of the run that added the last three.

`--record` writes the raw `workspace/symbol` answers into
`src/lib/lsp/__fixtures__/`, which `symbolSearch.realservers.test.ts` ranks in
the normal offline suite. That is the division of labour worth keeping: this
script proves the SERVERS still behave as documented, and the unit test proves
termic's rules still turn that into the right list.

## Measuring, before believing

`scratchpad/lsp-probe.mjs` drives a real server the way the Rust host does:
same resolution, same cwd, same `initialize` patching, same replies. It prints
hover, definition, diagnostics, completions and RSS.

```sh
node scratchpad/lsp-probe.mjs python /path/to/repo src/models.py 64 7
SYMBOL_QUERY=Store SYMBOL_OUT=fixture.json node scratchpad/lsp-probe.mjs python /path/to/repo src/models.py
```

Every number in this file came out of it. When a server behaves oddly, the
answer is another probe run, not another guess.
