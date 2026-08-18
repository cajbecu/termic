// Steady-state RSS and RSS growth across repeated view churn.
//
// Why memory rather than CPU: this is the one metric of the four the roadmap
// names that a shared 3-core VM can say anything honest about. A leak shows up
// as a monotonic trend across iterations, not as a percentage, so neighbour
// noise moves the absolute number without destroying the delta. CPU on the
// same runner is dominated by noise we cannot see or control, which is why it
// stays in `make perf` and out of CI. See docs/perf-ci.md.
//
// The delta is the interesting row, not the absolute. Absolute RSS depends on
// the runner image; growth-per-iteration is a property of our code.

import { clickByText, requireTermicApi, waitForAppShell, waitForText, waitForTextGone } from "../../../e2e/helpers";
import { fact, record } from "../report.js";
import { findAppPid, sampleRss, trend, waitForStableRss } from "../proc.js";

/** View-churn cycles. A cycle is two clicks and two waits, ~0.5s on the runner,
 *  so these are cheap and more of them is strictly better: the slope below
 *  separates from noise roughly with the square root of the count. 12 was the
 *  old default and too few to say anything. Raise further via the workflow's
 *  `memory_cycles` input when chasing a slow drip. */
const CYCLES = Number.parseInt(process.env.TERMIC_PERF_CYCLES ?? "", 10) || 30;
/** Cycles dropped from the trend. The first passes through cold React trees,
 *  lazy chunks and a JIT that has not seen this path, all of which allocate
 *  once and would tilt a slope fitted from cycle 0 upwards forever. */
const WARMUP = 5;
/** Below this, |slope| is reported as noise rather than as a leak. A cycle
 *  allocating a tenth of a MiB and never freeing it is 3 MiB per 30 cycles,
 *  which is under the RSS jitter this samples through; anything at or above it
 *  compounds into something a user would feel over a day's session. */
const SLOPE_FLOOR_MIB = 0.1;

describe("memory", () => {
  it("reports steady-state RSS and growth across view churn", async () => {
    await waitForAppShell();
    await requireTermicApi();

    const pid = findAppPid();
    fact("appPid", pid === null ? "not found" : String(pid));

    // Poll until RSS stops moving. A fixed pause here caught the startup peak
    // and made "growth" read -355 MiB, which measured startup decay rather
    // than the cycles. See waitForStableRss.
    const settleBaseline = await waitForStableRss(pid);
    const baseline = settleBaseline.snapshot;
    fact("baselineSettled", settleBaseline.settled
      ? `yes, after ${Math.round(settleBaseline.waitedMs / 1000)}s`
      : `NO — gave up after ${Math.round(settleBaseline.waitedMs / 1000)}s, still moving; growth below is unreliable`);
    record({
      metric: "memory.baseline.appMiB",
      value: baseline.appMiB,
      unit: "MiB",
      note: "Tauri process, once RSS stopped moving",
    });
    record({
      metric: "memory.baseline.helpersMiB",
      value: baseline.helpersMiB,
      unit: "MiB",
      note: `${baseline.helperCount} WebKit helper process(es)`,
    });
    record({
      metric: "memory.baseline.totalMiB",
      value: baseline.totalMiB,
      unit: "MiB",
      note: "app + helpers",
    });

    // Churn: mount and unmount real React trees. Deliberately NOT task
    // creation, which would spawn git worktrees and measure disk more than
    // memory. Dashboard/History is cheap, real, and exercises the view swap
    // every session performs constantly.
    // Sampled per side, not just as a total: WHICH process grows halves the
    // search before anyone reads code. The Tauri process is Rust (task records,
    // PTY buffers, IPC); WebContent is the webview (React trees, JS heap, DOM).
    // A total that grows says only "something does".
    const perCycle: number[] = [];
    const perCycleApp: number[] = [];
    const perCycleHelpers: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      await clickByText("Dashboard");
      await waitForText("HOME FOR YOUR CLI CODING AGENTS");
      await clickByText("History");
      await waitForTextGone("HOME FOR YOUR CLI CODING AGENTS");
      const s = sampleRss(pid);
      if (s.totalMiB !== null) perCycle.push(s.totalMiB);
      if (s.appMiB !== null) perCycleApp.push(s.appMiB);
      if (s.helpersMiB !== null) perCycleHelpers.push(s.helpersMiB);
    }

    // Settle again, the same way, so baseline and after are measured on
    // comparable footing. Comparing a settled baseline against a mid-churn
    // final read would manufacture growth that is really just transient.
    const settleAfter = await waitForStableRss(pid);
    const after = settleAfter.snapshot;
    fact("afterSettled", settleAfter.settled
      ? `yes, after ${Math.round(settleAfter.waitedMs / 1000)}s`
      : `NO — gave up after ${Math.round(settleAfter.waitedMs / 1000)}s`);

    record({
      metric: "memory.after.totalMiB",
      value: after.totalMiB,
      unit: "MiB",
      note: `after ${CYCLES} view-churn cycles`,
      samples: perCycle,
    });

    // THE row: the slope of RSS against cycle number, over the samples taken
    // DURING the churn.
    //
    // It used to be `after - baseline`, which is only meaningful if both ends
    // were caught on a flat stretch. They were not: the first CI run settled
    // its baseline 8s into a startup decay that was still shedding memory, so
    // the "growth across 12 cycles" it reported was -88.8 MiB, i.e. the decay,
    // measured with a leak's units and a leak's name. A trend fitted across
    // the cycles cannot be fooled that way, because a one-off decay before the
    // first cycle is not in the samples at all.
    const measured = perCycle.slice(WARMUP);
    const t = trend(measured);
    const slope = Math.round(t.slope * 100) / 100;
    const leaking = Math.abs(slope) >= SLOPE_FLOOR_MIB;
    record({
      metric: "memory.growth.slopeMiBPerCycle",
      value: measured.length >= 2 ? slope : null,
      unit: "MiB/cycle",
      note: leaking
        ? `THE row to watch. Fitted over ${t.n} cycles (first ${WARMUP} dropped as warm-up), r2 ${t.r2.toFixed(2)}. |slope| >= ${SLOPE_FLOOR_MIB}, so this is a trend to explain, not jitter`
        : `THE row to watch. Fitted over ${t.n} cycles (first ${WARMUP} dropped as warm-up), r2 ${t.r2.toFixed(2)}. |slope| < ${SLOPE_FLOOR_MIB} MiB/cycle: no trend above the noise floor`,
      samples: measured,
    });
    // r2 as its own row so a series can be read without re-parsing prose: a
    // large slope with r2 near 0 is a line through scatter, and treating it as
    // a leak is how a nightly earns a reputation for crying wolf.
    record({
      metric: "memory.growth.trendFit",
      value: measured.length >= 2 ? Math.round(t.r2 * 100) / 100 : null,
      unit: "r2",
      note: "how much of the RSS variance the slope explains; near 0 means the slope is noise whatever its size",
    });

    // Where the slope lives. Recorded unconditionally, including when the total
    // is flat: "neither side moved" is the reading that makes a flat total
    // trustworthy, and two rows that disagree in sign (one growing while the
    // other is reclaimed) is a thing a total actively hides.
    for (const [name, samples, what] of [
      ["memory.growth.slopeAppMiBPerCycle", perCycleApp, "Tauri/Rust process"],
      ["memory.growth.slopeHelpersMiBPerCycle", perCycleHelpers, "WebKit helpers, mostly WebContent"],
    ] as const) {
      const m = samples.slice(WARMUP);
      const st = trend(m);
      record({
        metric: name,
        value: m.length >= 2 ? Math.round(st.slope * 100) / 100 : null,
        unit: "MiB/cycle",
        note: `${what}; r2 ${st.r2.toFixed(2)} over ${st.n} cycles. Splits the total slope by process, so a growing side names itself`,
        samples: m,
      });
    }

    // Kept, demoted: still the honest answer to "did it end heavier than it
    // started", which is worth having next to the slope, and it is the row that
    // exposes a baseline caught mid-decay (a large negative here with a flat
    // slope means the settle gave up too early, not that memory was reclaimed).
    const delta =
      after.totalMiB !== null && baseline.totalMiB !== null
        ? Math.round((after.totalMiB - baseline.totalMiB) * 10) / 10
        : null;
    record({
      metric: "memory.endToEndDeltaMiB",
      value: delta,
      unit: "MiB",
      note: `settled RSS after ${CYCLES} cycles minus settled RSS before; diagnostic, not the leak signal (see slopeMiBPerCycle)`,
    });
  });
});
