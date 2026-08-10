# termic MCP endpoint (design)

MCP updated its specification (revision 2026-07-28), and we should
reevaluate our stance on MCP. Two things make the case.

First, the new revision made the protocol stateless. No handshake, no
sessions; every request authenticates itself. A per-task bearer token
now answers the question that killed every earlier design: WHICH task
is calling, and what may it do. Combined with a listener bound to one
loopback port, the grant to a caged agent shrinks from "a terminal"
to "one TCP port and one env var" - the narrowest hole seatbelt can
express.

Second, the CLI was always the wrong surface for agent control; we
chose it because it beat MCP v1 at the time, and that tradeoff no
longer holds. Granting an agent the CLI is granting terminal access:
a shell, an exec'd binary, a readable token file, a socket connect.
That is too permissive a grant to hand a sandboxed agent, and it
cannot be made narrow, so cli.md makes it zero: caged agents get no
control plane at all. A caged orchestrator today cannot create or
drive subtasks, period.

So: sandboxed agents get a scoped control plane for the first time
(a caged orchestrator farming out subtasks to caged workers, without
holding an escape), and outside MCP clients get the surface the
parked `termic mcp` shim was for, at no extra cost. This doc reopens
that parked question and settles the architecture and security
constraints before any code.

Non-goals: a separate daemon (this is an in-process loopback listener,
like the automation bridge and proxy), remote access, replacing the
CLI, or any event/notification stream in v1.

## Why reopen this

The stdio shim was parked because its only audience was outside
orchestrators nobody had, MCP tool definitions cost context tokens in
every session, and the CLI already served agents with shells. All
still true for the outside audience.

The new audience is INSIDE the sandbox. cli.md rules that caged agents
get no CLI surface: the socket is all-or-nothing under seatbelt, and
identifying which task a socket peer belongs to is unreliable. It
defers the fix as "scoped tokens placed inside the cage". Three
things in the 2026-07-28 revision make that buildable now:

1. **Stateless protocol.** No handshake, no sessions; every request
   carries its own identity. A bearer token per request maps exactly
   onto the token -> {task, scope} model cli.md wanted. Earlier MCP
   revisions were session-bound and would have reintroduced the
   caller-identification problem.
2. **Plain HTTP.** With sessions, resumability, and server-initiated
   requests gone, a loopback endpoint is simple request/response, and
   loopback TCP is something seatbelt can grant per task with
   primitives we already use.
3. **Cacheable tool lists.** Deterministic ordering and ttlMs blunt
   (not erase) the context-cost objection.

Unchanged: settle detection stays heuristic, so `wait` carries the
same caveat as `termic wait`, and no event stream ships before hooks.

## CLI access is terminal access; MCP access is a port

Granting a caged agent the CLI means granting a program: a shell, an
exec path for the binary, a read on the token file, a socket connect.
That is several seatbelt holes in an allow-list that user, repo, and
agent layers can extend, and cli.md documents how an allow-listed
ancestor silently re-exposes a denied path. The grant is ambient and
hard to audit, which is why cli.md made it zero instead of narrow.

The MCP grant is one TCP connect to one pinned loopback port plus one
env var holding a scoped token. No exec, no file reads, no socket, no
interaction with the FS allow-list. It is the narrowest grant seatbelt
can express and it is per-task by construction (the token is the
identity).

Two clarifications:

- The original CLI-over-MCP call was right at the time: for uncaged
  agents the CLI adds convenience, not capability, and MCP was still
  stateful. The ranking flips only for the in-cage audience, and only
  now that the protocol is stateless.
- MCP tools calling the CLI's implementation is fine. The risk is
  what the agent is granted, not what the server reuses internally.
  MCP dispatch goes through the same verb registry and cli_server
  paths; the agent never gets a shell, binary, or socket.

## Architecture

```
caged agent ──loopback HTTP──┐
uncaged / outside MCP client ┤──  Termic.app
                             │    ├─ Rust: mcp server (own thread)
                             │    │   ├─ stateless JSON-RPC core
                             │    │   ├─ token -> scope registry
                             │    │   └─ dispatch = cli_server's paths
                             │    └─ webview: same __termic.rpc handlers
```

- One app-wide listener on `127.0.0.1`, OS-assigned port, own thread
  (never the IPC thread). Not routed through the CONNECT proxy: the
  proxy is per-task and Enforce-only, so EnforceFs and Monitor would
  be stranded.
- Dispatch reuses the CLI server's two domains: Rust-native reads
  answer directly, orchestration goes through the webview RPC
  registry. MCP is a third presentation of the same verbs, never a
  third implementation, and it never execs the `termic` binary. Tool
  definitions are GENERATED from the same metadata as `help --json`
  so the surfaces cannot drift.
- The CLI is not replaced or diminished; the two surfaces serve
  different callers over the one implementation. CLI: humans,
  scripts, and uncaged agents with shells (zero context cost until
  invoked, pipes and exit codes, `attach` gives a real TTY, which no
  tool call can). MCP: caged agents, the only surface they can safely
  be granted, and MCP-native outside clients without a terminal.
- Hand-rolled stateless core: `POST /mcp` with `server/discover`,
  `tools/list`, `tools/call`, `_meta` validation, the spec's typed
  errors and headers. No sampling/roots/logging (deprecated anyway),
  no subscriptions, no MRTR. The rmcp SDK is beta and buys machinery
  we don't need; revisit if subscriptions ever land.
- Legacy clients: answer `initialize` statelessly (track nothing),
  swallow `notifications/initialized`, treat requests without `_meta`
  version fields as 2025-11-25. We accept the old handshake; we do
  not implement old sessions or resumability.
- `task_wait` is a bounded tool (`timeoutMs`, server-capped at
  minutes) returning `{outcome, state}`; callers loop. No hour-long
  hanging POSTs. Same quiescence semantics and staleness rules as
  `termic wait`.
- No `attach` (a TTY stream is not a tool call), no `quit`.

## Sandbox

The socket stays denied in-cage; nothing in cli.md's boundary changes.
The MCP port is the new, deliberately narrow hole. Two knobs in the
task's sandbox config, seeded from the project like hosts/paths:

1. **"MCP" checkbox** (default OFF). On = `provision()` renders the
   port allow and mints the task's token.
2. **"Projects" allow-list** (default: the task's own project). Which
   projects the token's tools may act on, checked server-side on
   every request. This is the `projects` half of cli.md's `{verbs,
   projects}` scope grain; verbs are fixed per scope class in v1.

Mechanics:

- **Provisioning.** `provision()` mints an independent random token,
  registers token -> {task_id, projects, scope}, and injects
  `TERMIC_MCP_URL` + `TERMIC_MCP_TOKEN` into that task's PTY env
  overlay only. Revoked at archive and at sandbox edits (which
  already SIGKILL PTYs).
- **Seatbelt: one port, not loopback.** Enforce adds exactly
  `(allow network-outbound (remote tcp "localhost:<mcp-port>"))` when
  the box is checked, emitted after the broad allows (last-match-wins,
  same discipline as the socket deny). The listener binds before any
  caged spawn so the port is known at render; a rebind means SIGKILL
  + reprovision for live cages. EnforceFs (`allow network*` by
  design) and Monitor reach the port regardless; the missing token is
  the gate there, same accepted posture as Monitor's socket
  reachability. cli.md's token invariants carry over: the full token
  never enters any env; the data dir deny stays the final FS rule.
- **Uncaged tasks** get a `full`-scope per-task token when the
  feature is on (attribution, not new capability). Outside clients
  (Claude Desktop etc.) authenticate with the existing `cli-token`
  file, mapping to `full`, so the endpoint doubles as the surface the
  original `termic mcp` was for. No stdio shim needed.

**Scoped requests pass two checks in order.** First the project
allow-list. Then monotonicity, because project scope alone is an
escape: a caged agent sending into an UNCAGED task in an allowed
project runs commands by proxy. cli.md's rules apply verbatim:

- `task_send` may only target tasks whose EFFECTIVE capability is a
  subset of the caller's. Compare effective, never stored lists:
  EnforceFs's effective network is ALL hosts regardless of its stored
  list; Off and Monitor are unbounded; Enforce > EnforceFs.
- `task_new` caps the child at the caller's effective capability:
  mode at least as strict, allow-lists a subset, control plane at
  most scoped, never uncaged YOLO.
- Reads leak: `task_list` is full-scope only (other projects' task
  names/paths are what the cage hides; the project list widens what a
  token may act on, never what it may enumerate). Scoped callers see
  themselves and tasks they created through the token (the server
  records parentage).

Scoped v1 tools: `task_new`, `task_send`, `task_wait`, `task_status`,
`task_result`, `task_log`, `task_diff`. Full scope adds `task_list`,
`task_archive`, `task_apply`, `task_open`, `task_rename`,
`project_*`. `tools/list` reflects the caller's token scope
(`cacheScope: private`, generous ttlMs).

## Spec notes (2026-07-28)

- Every result: `resultType: "complete"` + serverInfo in `_meta`.
- `server/discover` implemented, versions `["2026-07-28",
  "2025-11-25"]`, capabilities `{tools: {}}`.
- Version mismatch -> -32022; missing required `_meta` -> -32602/400
  (unless legacy-shaped).
- Deterministic tool order (registry order).
- No icons, prompts, or resources in v1 (resources would double the
  context-cost surface).
- Auth: loopback bearer token on every request; the spec's OAuth
  framework is for real HTTP deployments, and the STDIO-style
  "credentials from the environment" posture is the sanctioned local
  shape.

## Settings and exposure

Same landing discipline as the CLI: merged is not live.

- Global "Enable MCP endpoint" setting, default OFF. Off = not bound
  (no first-run dead end here, unlike the CLI socket, so
  bind-on-enable is safe).
- The two per-task knobs above, default off / own-project.
- `TERMIC_MCP_URL`/`TERMIC_MCP_TOKEN` injected only when both levels
  agree, so the advertisement is never a lie.
- docs/cli-agent-instructions.md gains a short MCP section.

## Phasing

- **Phase A: endpoint + full scope.** Listener, stateless core,
  legacy tolerance, registry-generated tools, `cli-token` -> full.
  Outside clients work; nothing in-cage changes. Measures real client
  behavior and context cost before any security-sensitive work.
- **Phase B: scoped tokens.** The two sandbox knobs, provisioning,
  parentage, project filter + monotonicity, seatbelt port allow,
  scope-filtered `tools/list`. Its own PR and review; this IS
  cli.md's deferred scoped-access phase and inherits its invariants.
- **Phase C (unscheduled): subscriptions / tasks extension.** Only
  after agent hooks give exact done signals; publishing heuristic
  settles on a stream is the `termic events` mistake, already ruled
  out.

## Testing

E2e rig (isolated `TERMIC_DATA_DIR`, fake-agent) plus:

- Stateless core: golden tests per method, legacy `initialize` path,
  `_meta` rejection matrix, header checks.
- Registry parity: `help --json` and `tools/list` render from one
  source; drift = red.
- Sandbox, behavioral: in an Enforce cage without the checkbox, the
  MCP port refuses; with it, the MCP port connects and every OTHER
  loopback port still refuses. A scoped token cannot call full-scope
  tools, target outside its project list, send to a less-caged
  target, create a less-caged child, or read other tasks. The
  hostile-ancestor-allowlist fixture reruns against the token file
  invariants.
- Record the serialized scoped `tools/list` size in a test so surface
  growth is a conscious diff.

## Traps

- Listener on its own thread; blocking tools park on the cli_server
  condvar machinery. No sync IO near the WKWebView loop.
- `pty_spawn` copies the app env into every child. The full token
  must never enter the app env; scoped tokens enter exactly one
  task's overlay. Behavioral tests, not reasoning.
- Effective vs stored capability (EnforceFs = all hosts). Any subset
  check on stored lists is an escape.
- The MCP surface never grows logic the app doesn't have: no merge
  orchestration, no offline reads, no direct data-file access.
- CSP untouched; the listener adds no webview egress.
- Spec is days old, SDKs are betas. Pin the revision string; nothing
  in Phase B's security depends on the spec (tokens and seatbelt are
  ours), so spec churn can't weaken the boundary.

## Open questions

1. Which agent CLIs speak streamable-HTTP MCP as clients today, at
   which revision? Phase A's in-cage value is zero until claude does.
2. Does caged `task_new` ship in Phase B v1, or does scoped v1 start
   with send/wait/reads and add create after field experience?
3. One credential file or two? Reusing `cli-token` for full-scope MCP
   is one story but couples rotation.
