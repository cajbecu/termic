# Agent-driven orchestration (research)

**Status: research, not a build order.** The question is not whether
agents can drive other tasks. They can, and they are already told how.
The question is whether the telling actually lands, and how much
orchestration shape termic should have an opinion about.

The plumbing exists and is complete. `termic new` creates a task and
starts its agent with a prompt, with `--wait`. `termic wait` blocks on a
work state. `termic send` pushes a message into a running task.
`termic result`, `termic logs`, `termic status`, `termic archive` close
the loop, all with `--output-format json`. Composed, that already
expresses "start B when A finishes", which is the primitive everyone is
racing to ship.

The telling exists too. Every spawned agent gets `TERMIC_CLI`,
`TERMIC_CLI_TOKEN`, `TERMIC_TASK_ID` and `TERMIC_CLI_HELP` in its
environment (`src-tauri/src/lib.rs`), and the help string is a real
tutorial: spawn with `--sandbox enforce --wait`, drop findings in
`RESULT.md`, prompt an existing task with `send --wait`, branch on exit
codes (0 done, 3 needs input, 7 timeout, 9 prompt not delivered), rename
your own task once you know what it is really about.

So the gap is narrower and more specific than "agents cannot
orchestrate". Two things:

1. **Env vars are passive.** `TERMIC_CLI_HELP` is only read if the agent
   happens to look at its environment. Nothing puts it in context. Xirp
   puts the equivalent text in the system prompt, where it is in context
   on turn one whether the agent goes looking or not.
2. **termic has no opinion about shape.** Nothing suggests fanning out,
   queueing, or a supervisor pattern. The surface is there, the intent
   is entirely the user's. That is a defensible position, and it is also
   possibly just an unmade decision.

## What Xirp does

Measured from a real install of Xirp 0.12.0 in August 2026. Full
teardown in [xirp.md](xirp.md); this is the orchestration part.

Every session is launched with `--append-system-prompt` carrying a
tutorial for their own CLI. Paraphrased from the injected text:

- `chirp session new --goal "<task>" --name "<3-5 words>"` creates a
  session in the background, no view switch.
- `--new-branch <name>` names the worktree branch.
- `--depends-on [id]` queues the new session as a child that starts
  after the current one completes. With no id it uses the caller's own
  session id, which is available as `CHIRP_SESSION_ID` in the env.
- `--project <ref>` targets a different project by name, path or UUID.
- `--json` returns `{id, name, branch, worktreePath}`.

The injected prompt also carries trigger examples: "refactor the auth
module, and in parallel update the tests" spawns two sessions, "after
you're done with this, deploy to staging" spawns one with
`--depends-on`.

So their orchestration surface is not a UI. It is natural language, and
the API is the system prompt. Fan-out happens because the user asked for
two things in one sentence.

Worth noting: their own daemon log shows `chirp --help` failing with
`command not found` in the external build, so whether the injected
tutorial resolves end to end outside Spotify is unverified.

## Why this is interesting

The design bet is that nobody adopts a DAG editor. Given a canvas with
boxes and arrows, engineers will keep typing prompts instead. Putting
the orchestration in the prompt means the feature ships with no UI at
all, and the discovery problem is solved by the model rather than by
documentation.

The cost is that the graph stays implicit. You cannot see the shape
before it exists, you cannot replay it, and the agent decides how wide
to fan out. The trust question moves from "is this code correct" to
"did it fan out the way I meant".

## Questions this research has to answer

1. **Does injection actually work?** Put termic's CLI surface into
   `--append-system-prompt` (or the equivalent for each agent) and see
   whether agents reach for it unprompted, at the right moments, without
   being nagged. Measure false starts too: an agent that spawns three
   tasks when the user wanted one is worse than an agent that spawns
   none.
2. **What is the minimum prompt?** Every token of injected tutorial is
   paid on every turn of every session. Xirp's is roughly 200 words.
   Find the shortest text that produces correct behaviour, or decide
   this belongs in MCP tool definitions instead, where the schema is the
   documentation (see [../plans/mcp.md](../plans/mcp.md)).
3. **Prompt injection or MCP?** These are alternatives, not a sequence.
   The prompt route works today for every agent that accepts a system
   prompt append, costs context on every turn, and gives no argument
   validation. The MCP route is typed, discoverable and per-task
   scoped, but it only reaches MCP-capable clients and is still in
   design.
4. **Does `--depends-on` need to exist?** `termic wait <task> && termic
   send ...` already composes it. A dedicated flag is one call instead of
   two, and it survives the caller's own session ending. Decide whether
   that is worth a new surface.
5. **How much shape do we bake in?** Fan out, queue behind, supervisor
   and workers. Today termic bakes in none: the user asks, the tool
   obeys. That is a defensible position and it is also possibly just
   indecision. Xirp picked "the model decides, in English". A third
   option is to make the intended shape visible before it runs, without
   drawing a graph.
6. **Opt-in or default?** An agent that can spawn agents is a cost
   multiplier and a blast-radius multiplier. If injection ships, it
   almost certainly ships behind a toggle, and possibly with a cap on
   depth or on total spawned tasks.

## The sandbox constraint

Caged agents get no CLI at all. `sandbox.rs` denies the data dir and the
control socket, and [../plans/cli.md](../plans/cli.md) settles that
deliberately: granting an agent the CLI is granting terminal access.

So injecting a CLI tutorial into a sandboxed session teaches it to reach
for something it cannot have, which is worse than silence. Either
injection is skipped for caged tasks, or orchestration for caged agents
rides the per-task bearer token described in
[../plans/mcp.md](../plans/mcp.md), which was designed for exactly this.

## What termic already has

For reference, so the research does not rebuild it:

| Need | Command |
|---|---|
| Create a task, start the agent, inject a prompt | `termic new` |
| Adopt an existing worktree instead of creating one | `termic new --from <path>` |
| Resume a specific agent session | `termic new --resume <session-id>` |
| Block until a task reaches a work state | `termic wait` |
| Push a message into a running task | `termic send` |
| Read a task's outcome / logs | `termic result`, `termic logs` |
| Inspect state, diff, path | `termic status`, `termic diff`, `termic path` |
| Clean up | `termic archive` |

All of it is JSON-capable via `--output-format json`, which matters if
an agent is the caller.
