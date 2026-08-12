# Performance benchmarks in CI (investigation)

**Status: research, not a build order.** Nothing here is approved for
implementation. This doc answers one question, README roadmap item 12:
can "performance trumps polish" be enforced by CI instead of by review
and habit, and if so, which parts of it.

Sections marked **Finding** are things I read in a file and can point at.
Sections marked **Proposal** are a strawman for the findings to knock
over. The distinction matters here more than usual, because the first
version of this doc got its central claim about Orca wrong by reasoning
from script names instead of reading workflows.

The short answer: **yes, but only for metrics that are counts or
static facts.** App-level timings, CPU percentages and GPU utilisation
cannot be gated on a GitHub macOS runner. That split is not a compromise
invented here; it is what Orca independently converged on, and it maps
cleanly onto the bear traps in [performance.md](../performance.md).

## Finding: what Orca actually gates on

Reading [stablyai/orca](https://github.com/stablyai/orca)'s 28 workflows
rather than its `package.json`. It has a large bench surface:

```
bench:idle-cpu                  bench:startup
bench:main-thread-jank          bench:daemon-coldstart
bench:hang-watchdog-memory      bench:compare
bench:wsl-hook-relay-reattach   bench:wsl-git-shell
bench:macos-computer-helper-owner-loss
test:e2e:terminal-perf          test:e2e:terminal-perf:scale
test:e2e:terminal-perf:check-report ...:summarize ...:html-report
```

**The three benches named in our README enforce nothing.**
`run-idle-cpu-benchmark.mjs` launches Electron into an isolated home
dir, samples per-process CPU and RSS via `ps` (PowerShell
`Get-CimInstance` on Windows) at 1 s intervals for 30 s after a 15 s
warmup, classifies processes into `main`/`daemon`/`gpu`/`renderer`/
`utility`/`agent-or-node`, and prints mean/p95 CPU and max RSS per
category. It defines no pass/fail criteria. `main-thread-jank-bench.mjs`
is the same shape: `ORCA_MAIN_THREAD_DIAGNOSTICS=1`, parse
`[main-thread] {json}` from stderr every 5 s over a 120 s window after a
20 s warmup, aggregate event-loop stall counts (`maxGapMs`,
`gapsOver50Ms`, `gapsOver250Ms`) and subprocess spawn churn. Records
events over 50 ms and 250 ms; fails on nothing. These are instruments a
human runs while investigating.

**The app-level timing budgets exist but are not wired to PRs.**
`check-terminal-perf-report-budgets.mjs` does `exit(1)` on:

```js
const BUDGETS = {
  maxMedianKeyLatencyMs: 75,      maxWorstKeyLatencyMs: 300,
  maxRevisitLatencyMs: 300,       maxTimerDriftMs: 150,
  maxTimerDriftUnderLoadMs: 2_500, maxScrollLatencyMs: 150,
  maxRestoreLatencyMs: 1000,      maxRendererQueuedChars: 2*1024*1024,
  maxRendererPeakQueuedChars: 2*1024*1024,
  maxRendererDroppedBacklogs: 0,
}
```

A 75 ms median keystroke budget is not a "performance trumps polish"
bar, it is a "not visibly broken" bar. And `terminal-perf.yml`, the only
workflow in that area, runs on `workflow_dispatch` plus
`schedule: cron '30 8 * * *'`, on `ubuntu-latest` under `xvfb`, uploads
a JSON artifact with 14-day retention, and never invokes the budget
checker. Its comment: exercise it daily "so terminal throughput
regressions are caught before users report typing lag".

**But `pr.yml` does gate, on a different class of metric entirely.**
This is the part the first draft of this doc got wrong. Every PR runs,
on `ubuntu-latest`:

```yaml
- name: Check Zustand selector fan-out budget
  run: pnpm run check:zustand-selector-fanout
- name: Enforce React Doctor on changed lines
  run: pnpm run check:react-doctor:changed -- ${{ ...base.sha }}
- name: Enforce max-lines ratchet
  run: pnpm run check:max-lines-ratchet
- name: Check feature wall asset budget
  run: pnpm check:feature-wall-assets
```

`check:zustand-selector-fanout` is `zustand-selector-fanout-benchmark.mjs
--check`. It is named a benchmark and it is one, but it never launches
the app: it builds a store with `SUBSCRIBERS = 2500`, does
`WRITES = 2000` unrelated writes, runs 5 rounds and takes the median.
Its primary assertions are **counts** (expected selector runs, zero
unexpected render invalidations), with one very loose time backstop,
`MAX_MILLISECONDS_PER_WRITE = 5`. Exits 1 on violation.

Similarly `computer-e2e.yml` runs
`pnpm bench:macos-computer-helper-owner-loss --expect reaped --trials 1`
on PRs. A benchmark script used as a *behavioural* assertion, not a
timing one.

So the accurate statement is: **Orca gates PRs on counts, static facts
and headless pure-JS microbenchmarks with order-of-magnitude time
headroom. It gates nothing on app-level timings, CPU, or GPU, and its
instruments for those run nightly and report-only.**

That is a far more useful finding than "they gate nothing", and it is
independent convergence on the tier split proposed below. Note in
particular that their one runtime PR gate, Zustand selector fan-out, is
*termic's bear trap 5*.

## Finding: why termic cannot copy the runner strategy

Orca runs its perf suite on `ubuntu-latest` with `xvfb`. Electron is
Chromium; Chromium runs headless on Linux. Every PR-gating check quoted
above is on Linux.

Termic's app cannot run on Linux at all. WKWebView is macOS-only, so any
check that launches the app has to be on a macOS runner. Per GitHub's
runner reference, standard `macos-14` is **3 (M1) cores, 7 GB RAM, 14 GB
storage**, virtualised, and Apple's Virtualization Framework does not
expose Metal Performance Shaders to the guest.

The deltas termic cares about are small in absolute terms.
performance.md records the windowless-mode result as *"hidden 0.23% CPU
vs visible 0.33%"* and explicitly calls the delta directional rather
than a headline saving. A 0.1pp CPU delta is not resolvable on a shared
3-core VM.

(I could not confirm the macOS private-repo minutes multiplier from
GitHub's docs in this pass. Cost is a real consideration for a nightly
macOS job but I am not going to quote a number I did not verify.)

## Finding: the noise floor is already documented, and it is brutal

We have run this experiment. The GH #140 renderer benchmark
(`scratchpad/gpu-bench/`, gitignored) tried to reproduce a shipped claim
that the WebGL renderer costs ~33pp of WindowServer CPU while idle. It
did not reproduce: the measured delta was 1.4-2.5pp. Getting there took
four invalidated runs. The traps are recorded in `measure.sh`:

| Trap | Effect |
|---|---|
| Comma-decimal locale | `awk` parsed `159639,08` as `159639`; every sub-second delta rounded to 0. Needs `LC_ALL=C`. |
| Occlusion, not focus | WKWebView throttles when occluded, collapsing WindowServer/WebContent/WebKit.GPU *simultaneously*. Reads as "the GL surface is free". |
| Canvas pixel count | 1500x1000 at DPR 1 is ~0.8M pixels; a Retina laptop is ~3.2M. Not comparable until maximised. |
| Cursor blink | `cursorBlink: true` is hardcoded, so a focused terminal is never idle. DOM arm: 4.0% focused vs 0.1% blurred, a 40x swing. |
| `WebKit.GPU` is not a WebGL signal | It is WebKit's compositing process, busy under the DOM renderer too. |
| Startup noise | A fixed sleep after launch caught WebContent at 12%. Must poll until quiet. |
| Ambient typing | The user typing anywhere, including in another app, breaks a run. |

Map those onto a runner. The occlusion guard is `lsappinfo front`, which
is meaningless in a runner session. "Maximise first" is unverifiable
when nothing is watching. "Poll until quiet" cannot distinguish app
startup from a noisy neighbour. The cursor-blink confound makes the
metric depend on which pane holds focus.

Every one of those produced a *plausible wrong number*, not an error.
That is the failure mode to design against, and it is how a 33pp claim
reached the 0.26.0 changelog. A gate that launders noise as evidence is
worse than no gate.

## Proposal: gate counts, track times

The regressions performance.md exists to document were almost never
"this got 8% slower". They were structural:

- `visibility: hidden` instead of `display: none`, so hidden terminals
  kept issuing WebGL draws (bear trap 2). GPU ~90% busy while idle.
- `loop { sleep(8ms) }` in the PTY flusher, 125 wakeups/s per PTY, and a
  `sleep(1ms)` exit-drain at ~1000/s (bear trap 8).
- Losing the `React.lazy` split on `EditorPane`/`DiffPane` (bear trap 1).
- A store patch per PTY chunk re-rendering the sidebar at chunk rate
  (bear trap 8).
- Destructuring the whole Zustand store instead of a tight selector
  (bear trap 5).

Each is **countable**. Zero timer wakeups on a quiet PTY is an
invariant. Live canvases in a hidden subtree is an integer. Sidebar
renders during 5 s of streaming is an integer. Whether `EditorPane` is
its own chunk is a build-time fact. None depend on machine speed,
neighbours, or a virtualised GPU. That is what makes them gateable on a
3-core VM, and it is the same reasoning that put Orca's gates on Linux.

### Tier 0: headless microbenchmarks (vitest, any OS)

The tier I missed in the first draft, and the cheapest one. Orca's
selector fan-out check is pure JS against its own store, so it runs in
the normal Linux test job with no app, no window, no GPU.

Termic can do the same in the existing `npm test` job: build the real
Zustand stores, attach N subscribers, perform unrelated writes, and
assert selector-run and render-invalidation *counts*. That is bear trap
5 turned into a required check on every PR, at nearly zero cost, on the
`ubuntu-latest` job we already run. Copy Orca's shape including the
loose time backstop, and keep the counts as the real assertion.

### Tier 1: PR-gating in the existing macOS e2e job

Deterministic, count-or-structure only. Candidates, each mapped to the
trap it guards:

| Check | Guards |
|---|---|
| Hidden panes have zero live canvases and zero geometry | bear trap 2 |
| Windowless mode drops the active pane's display exemption | bear trap 2b |
| Quiet PTY costs zero timer wakeups (Rust counter, `cargo test`) | bear trap 8 |
| PTY output coalesces to <=1 event per 8 ms | bear trap 8 |
| `lastOutputAt` patches coalesce to <=1 per 500 ms | bear trap 8 |
| Sidebar/tab render count during streaming is bounded | bear traps 5, 8 |
| `EditorPane`/`DiffPane` stay in separate chunks (vite manifest) | bear trap 1 |
| Entry bundle size under a byte ceiling | cold start |
| Settle-timing knobs stay above the floor | already done, `settleTiming.test.ts` |

I have not verified the implementation cost of any of these. The Rust
wakeup counter in particular needs a look at the flusher/waiter code
before it is more than an idea.

**RSS growth is the borderline case worth trying.** Memory is far less
noise-sensitive than CPU; a leak is a monotonic trend, not a percentage.
`wdio.conf.ts` spawns the app from Node, so the suite can shell out to
`ps -o rss=`. Open and close N tasks, settle, assert
`rss_after - rss_baseline` is under a ceiling. Gate on the delta across
iterations, never on absolute RSS, and start it report-only until real
CI runs show the distribution.

### Tier 2: nightly, report-only

Same shape as Orca's `terminal-perf.yml`, for the same reason. Cron plus
`workflow_dispatch` on `macos-14`, JSON artifact.

- Cold start to first paint. Needs a first-paint marker; none exists.
- Main-thread jank as frame-gap counts, bucketed over 50 ms and 250 ms.
- Absolute RSS at steady state.

Trend lines a human reads. The value is that "feels slower lately"
becomes a chart with a bisect range.

### Tier 3: local only, real hardware

Idle CPU, WindowServer cost, GPU utilisation, renderer A/B. Needs a real
GPU, a real display, a controlled desktop, and all seven trap
mitigations. Maintainer's machine, nowhere else.

Concrete and independent of everything above: **promote
`scratchpad/gpu-bench/` into the tracked tree.** It is gitignored
session-scoped scaffolding encoding seven hard-won traps that will
otherwise be rediscovered.

## Finding: one stale doc line

**CLAUDE.md says the e2e suite is "laptop-only, no CI".** It is not.
`.github/workflows/test.yml` has an `e2e` job on `macos-14` that builds
the `--features e2e` binary and runs the full suite on every PR. Its own
comment says it is deliberately not a required check yet, "here to
surface flakiness so we can harden it before gating merges on it". That
job is the delivery vehicle for all of Tier 1, so the stale line hides
what is already available.

README item 12 also credits Orca with CI-wired gates in a way this
research does not support. Worth a rewrite, since the true story is a
better argument for the tiered approach than the current framing.

## Recommendation

Feasible, with the scope inverted from how the roadmap item states it.

The four targets the roadmap names (idle CPU, cold start to first paint,
main-thread jank, RSS growth) are three durations and a percentage.
Those are exactly the category that cannot be gated on a virtualised
3-core runner without manufacturing false confidence. Do not build them
as PR gates.

Suggested order:

1. **Tier 0 selector fan-out test in vitest.** Cheapest, runs on the
   Linux job that already exists, gates bear trap 5, directly modelled
   on a script known to work in production elsewhere.
2. **Promote the gpu-bench harness out of scratchpad.** Standalone
   value, no dependencies, preserves knowledge that is one
   `rm -rf scratchpad` from gone.
3. **Fix the stale CLAUDE.md line.**
4. **Three Tier 1 invariants as e2e specs**: hidden-pane canvas count,
   PTY event coalescing, sidebar render count under streaming. Per
   CLAUDE.md each lands with the change it guards; per the `e2e` skill
   each spec carries several cases, not one.
5. **RSS-delta as a report-only e2e step.** Collect distribution data
   across real CI runs before choosing a ceiling.
6. **Only then** the Tier 2 nightly job, and only if 4 and 5 show the
   harness is stable enough to be worth reading.

## Open questions

- Does the `macos-14` e2e job get a real window server session, and does
  WKWebView get a hardware WebGL context or fall back to software? All
  of Tier 2 depends on this; Tier 1 is designed not to care. Cheap to
  settle: log `UNMASKED_RENDERER_WEBGL` from the e2e binary on one run.
- Does WKWebView support `PerformanceObserver` `longtask`? Sources
  disagree (Safari 17+ is claimed to support it). If not, Tier 2 jank
  measurement has to be a self-instrumented rAF-gap loop. Verify against
  the actual WKWebView build before designing around either answer.
- Is a render-count instrument acceptable behind the `e2e` feature flag?
  It must not exist in release builds.
- Where does the Rust wakeup counter live so it costs nothing when off?
- What is the macOS private-repo minutes multiplier, and does a nightly
  macOS job fit the budget?
