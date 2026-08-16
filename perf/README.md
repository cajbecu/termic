# perf/ — the nightly performance suite

Startup timing and memory growth, measured against the real macOS window by
the same WebdriverIO stack the e2e suite uses.

```sh
make perf       # both sections: this suite, then the local-only bench/
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
| `memory.growth.totalMiB` | Growth across N view-churn cycles. **The row to watch.** Absolute RSS is runner-dependent; growth is a property of our code. |
| `memory.growth.perCycleMiB` | Per-cycle growth. A steady positive value is the leak signal. |

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
[`bench/README.md`](../bench/README.md) produces a plausible wrong number
rather than an error. They live in `bench/` and run as section 2 of
`make perf`. Orca reaches the same conclusion: its `bench:idle-cpu`,
`bench:startup` and `bench:main-thread-jank` are invoked by none of its 28
workflows.
