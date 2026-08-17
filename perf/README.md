# perf/ — the two performance suites

Two halves, split by what can be honestly measured where. Neither gates a PR.

- **[`nightly/`](nightly/)** — startup timing and memory growth, measured
  against the real macOS window by the same WebdriverIO stack the e2e suite
  uses. Runs in CI nightly; reports, does not gate.
- **[`local/`](local/README.md)** — CPU, GPU and compositor cost, as shell
  scripts you run on your own Mac. Never in CI, because a virtualised runner
  cannot measure any of it without producing confidently wrong numbers.

Everything below is about `nightly/`.

```sh
make perf       # both sections: nightly/, then local/
make perf-ci    # this suite only (what the nightly workflow runs)
```

CI: `.github/workflows/perf.yml`, nightly at 03:30 UTC plus
`workflow_dispatch`. **Never on pull requests.**

## Why this is not a gate

The metrics here are durations and memory. `macos-14` is a 3-core virtualised
runner and Apple's Virtualization Framework does not expose Metal Performance
Shaders to the guest, so run-to-run spread is wider than most regressions worth
catching. A gate on that fails honest PRs and teaches everyone to re-run until
green.

What gates a PR instead is the count-and-invariant class, which is
machine-independent: `src/store/selectorFanout.test.ts` is the worked example.
The full argument, including why Orca can gate its nightly latency budgets and
we cannot, is in [docs/perf-ci.md](../docs/perf-ci.md).

A metric earns a threshold after its real spread is known, not before. The
90-day artifact retention exists so that decision can be made from data.

## What it measures

| Metric | Meaning |
|---|---|
| `startup.webviewToFirstPaintMs` | `performance.timeOrigin` to first painted frame. The half termic owns: bundle parse, React mount, store hydration, lazy-chunk boundaries. |
| `startup.bootToFirstPaintMs` | Process spawn to first painted frame, via the Rust `BOOT` instant. What a user waits through. Includes Tauri/WKWebView fixed cost. |
| `memory.baseline.*` | App RSS, WebKit helper RSS, and their total, 5s after the shell appears. |
| `memory.growth.slopeMiBPerCycle` | **The row to watch.** Least-squares slope of RSS against cycle number, over the churn samples with the first 5 dropped as warm-up. Read it WITH the fit below. |
| `memory.growth.trendFit` | r² of that slope. Near 0 means the slope is a line through scatter whatever its size, so a big slope with a poor fit is not a leak. |
| `memory.endToEndDeltaMiB` | Settled RSS after the cycles minus settled RSS before. Diagnostic: a large negative here with a flat slope means the baseline was caught mid startup-decay, not that memory was reclaimed. |

**Why a slope and not a difference.** Growth used to be `after - baseline`,
which only means anything if both ends were caught on a flat stretch. On the
first successful CI run they were not: the settle check accepted a baseline 8
seconds into a startup decay that was still shedding memory, and the run
reported **-88.8 MiB of "growth"**, i.e. the decay, wearing a leak's units and
a leak's name. A trend fitted across the cycles cannot be fooled that way,
because a one-off decay before the first cycle is not among its samples.

Two guards came with it, both unit-tested in `src/lib/rssTrend.test.ts`:
`isFlat` now requires a settle window to be narrow AND to have small net drift
(four samples falling 2 MiB each fit inside an 8 MiB spread while shedding
~120 MiB/minute), and `trend` reports r² so a slope can be judged rather than
believed.

Both startup numbers are reported because either alone misleads: the
webview-relative one flatters us by hiding platform cost, and the boot-relative
one hides our own regressions inside platform cost.

## Facts, not just numbers

`webglRenderer` and `hardwareWebgl` are recorded every run. They answer the
question that decides whether frame-timing work is worth doing at all: does
WKWebView get a hardware context on a CI runner, or is it falling back to
software? If it is software, any frame-gap metric describes the rasteriser
rather than termic. Recording it nightly means we notice if that changes.

## Layout

```
perf/
├── report.ts          collector + step-summary renderer
├── proc.ts            RSS sampling via ps
└── specs/
    ├── startup.perf.ts
    └── memory.perf.ts
wdio.perf.conf.ts      separate config, own spec set, JSON out
```

`report.ts` writes NDJSON rather than accumulating in memory, because
WebdriverIO forks a worker per spec and an in-memory array in the launcher
would come back empty. The launcher folds the NDJSON into `.perf/report.json`
on completion and appends a table to `$GITHUB_STEP_SUMMARY` so the numbers are
readable in the run UI without downloading an artifact. A nightly nobody reads
is dead weight.

## Adding a metric

1. Record it with `record({ metric, value, unit, note })`. Use a stable
   `metric` key: series are lined up by it.
2. Never throw on a slow value. This suite reports.
3. If the value is a median, pass `samples` too, so a weird median can be
   diagnosed without re-running.
4. Say in `note` what the number means, or why it is `null`. `null` means "not
   measured", never zero.

## What deliberately is NOT here

Idle CPU, WindowServer cost and GPU utilisation. Those need a real GPU, a real
display and an undisturbed desktop; on a runner each of the seven traps in
[`perf/local/README.md`](../perf/local/README.md) produces a plausible wrong number
rather than an error. They live in `perf/local/` and run as section 2 of
`make perf`. Orca reaches the same conclusion: its `bench:idle-cpu`,
`bench:startup` and `bench:main-thread-jank` are invoked by none of its 28
workflows.
