# Letting a user fix a language server that is answering badly

**Status: idea.** Nothing here is approved. It is the follow-up to
[../lsp.md](../lsp.md) (which replaced `plans/lsp.md` when the work shipped),
written after the first real use of code
intelligence on a Django project went wrong in three different ways in one
afternoon.

## What actually happened, because it frames everything else

Three failures, all on the same repo, none of them a bug in termic:

1. **The wrong server was chosen.** Python resolution is a fixed chain (zuban →
   ty → basedpyright). On a Django project with no `django-stubs`, ty reports
   every `Model.objects` as missing while zuban types it correctly, because
   zuban knows the ORM. The chain got it right here by luck of ordering. On a
   project where ty is the better answer, there is no way to say so.
2. **The UI named a different server than the one running.** The chip read
   "ty" because the name was keyed by LANGUAGE, and quoted ty's memory figure,
   while zuban was the process actually started. Fixed, but the class of
   mistake is the point: the app was describing a table, not the machine.
3. **The answers were right and useless.** `⌘-click` on a Django model landed
   in `django-stubs/db/models/base.pyi`, a file of signatures with `...` for
   every body. Correct answer to "what is the type", wrong answer to "show me
   this code". `lib/lsp/declarationSource.ts` now hops to the source.

The pattern: **a language server is only as good as its environment, and the
person who knows the environment is the user, not us.** Every idea below is a
way to hand them the lever instead of guessing on their behalf.

## 1. A language-server registry, shaped like the agent registry

The app already has this pattern and users already understand it: Settings →
Agents is a list of entries with a command, args, and capabilities, some
built-in and some user-added. A server registry is the same list with the same
editor:

```
id: zuban            languageIds: [python]
command: zuban       args: [server]
settings: {}         initializationOptions: {}
```

What it buys, in order of how much it matters:

- **Any language, not seven.** termic serves TypeScript, Python, Rust, Go, the
  C family, Swift and Ruby, because those are the arms in a `match` in
  `lib.rs`. Adding the last three took an afternoon each, which is the point:
  it is cheap for US and impossible for a USER. Someone who writes Elixir,
  Java, PHP or Zig gets nothing and can do nothing about it. With a registry
  they add a command and it works, without waiting for a release.

  Note what shipping three of them did NOT change: the argument for a registry
  is not "termic supports too few languages", it is that the set is ours to
  decide. Every language added shortens the list of people this matters to
  without changing what it costs them.

  **The rest is PARKED, deliberately, until somebody asks.** A custom command
  per language shipped too (rule 16b in [../lsp.md](../lsp.md)), which covers
  "I want to run pylsp" without opening the closed set. What is left is a new
  language SLOT: an eighth language needs its extensions, its LSP `languageId`,
  its detection markers, a display name, a measured memory figure and a catalog
  row, and each of those is a place where "a language termic knows nothing
  about" has to read as deliberate rather than broken. That is two to three
  days for a feature nobody has requested, and detection is something we would
  rather own than hand to a config file. If the requests come, this is the
  design; if they do not, this stays an idea.
- **Choosing between servers for one language becomes a normal act**, which is
  the Django lesson: the fix was not a setting, it was a different process.
  **SHIPPED, in the small.** Settings -> Editor -> Servers puts a radio on each
  candidate for Python and TypeScript, with Automatic for termic's own order
  (rule 16b in [../lsp.md](../lsp.md)). What is still missing is the registry
  half: adding a server termic has never heard of, per project rather than per
  machine, and a command line of your own.
- **`settings` and `initializationOptions` pass straight through.** This is the
  escape hatch that means we never have to model a framework we have never
  heard of: `rust-analyzer` cargo features, `gopls` build tags, pyright's
  `extraPaths`, a Vue plugin. The host already answers
  `workspace/configuration`; today it replies with `null` per item plus a
  hard-coded `pythonPath`. Merging a user block in is a contained change.

Per project, machine-local (`projects.json`), for the same reason
`code_intel_auto` is: whether this machine spends 3 GB on rust-analyzer is not
a colleague's decision. A `.termic.yaml` block for the parts that ARE
team-wide (which server this repo expects, its settings) can come later, and
should, because "this repo needs these flags" is exactly the knowledge that
gets lost between developers.

Cost: the registry UI is the expensive half, and it is mostly a copy of the
agent one. The plumbing (spawn a command, forward settings) already exists.

## 2. Environment notes, as a table rather than one hard-coded Django check

`lsp_offer` returns a single `caveat`, computed by `django_without_stubs`,
Python-only, and only when the checkout has a `.venv`. It was written for one
observed failure and it reads like it.

Generalise it into a list of detectors, each cheap (existence checks, no
process spawn), each returning what was found, what it will look like, and an
ACTION:

| Detected | What the user sees | Offer |
|---|---|---|
| Django, no `django-stubs`, server is ty/pyright | every model query underlined | install the stubs, or switch to zuban |
| `pyproject.toml` / `uv.lock` but no `.venv` | every import unresolved | say which interpreter is being used |
| `package.json` but no `node_modules` | TypeScript resolves nothing | run the install |
| Rust file behind a non-default feature | no answers in that file at all | set `cargo.features` |
| Go file behind a build tag | same | set `buildFlags` |

The rule that keeps this honest: a note is only worth adding when we have SEEN
the failure and can describe it in the words the user would use. A table of
speculative warnings is worse than no table, because it trains people to
dismiss the one that matters.

## 3. "Why is this answer wrong?", as a copyable report

The hardest part of the Django afternoon was not fixing it, it was working out
what was happening: which binary, which interpreter, which settings, whether it
had finished indexing. All of that is known to the app and none of it is
visible.

One menu item on the chip that copies a markdown block: server binary and
version, cwd, the `initialize` params and `workspace/configuration` replies
sent, server capabilities, index state, the last few server errors, and the
request/response for the symbol under the cursor. It turns "navigation is
broken" into something a person can paste into an issue, and it is how the
table in (2) gets its next row.

Cheap: everything in it is already in memory or in the host's own state.

## 4. Recipes, linked from the note that mentions them

A `docs/lsp-recipes.md` with one section per framework we have actually hit,
and the environment notes link to the anchor rather than restating it. Keeps
the in-app copy to one sentence and an action, which is all a tooltip should
carry.

## Deliberately not doing

**A "second opinion" mode** that runs the alternative server on the same file
and shows both answers. Tempting after the Django case, and wrong: it doubles
the memory bill at the exact moment the user is already unhappy, and the honest
version of it is (1), where they pick the server that suits the project once.

**Guessing the framework and installing packages.** The app should say
`django-stubs` is missing. It must not `pip install` into someone's project
environment: that environment is the project's, and a tool that edits it
without being asked is a tool people stop trusting.
