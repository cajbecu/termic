// Steady-state RSS and RSS growth across repeated view churn.
//
// Why memory rather than CPU: this is the one metric of the four the roadmap
// names that a shared 3-core VM can say anything honest about. A leak shows up
// as a monotonic trend across iterations, not as a percentage, so neighbour
// noise moves the absolute number without destroying the delta. CPU on the
// same runner is dominated by noise we cannot see or control, which is why it
// stays in `make perf` and out of CI. See docs/research/perf-ci.md.
//
// The delta is the interesting row, not the absolute. Absolute RSS depends on
// the runner image; growth-per-iteration is a property of our code.

import { clickByText, requireTermicApi, waitForAppShell, waitForText, waitForTextGone } from "../../e2e/helpers";
import { fact, record } from "../report.js";
import { findAppPid, sampleRss } from "../proc.js";

/** View-churn cycles. Enough that a per-iteration leak clears the noise floor,
 *  few enough to stay well inside the spec timeout on a slow runner. */
const CYCLES = 12;

describe("memory", () => {
  it("reports steady-state RSS and growth across view churn", async () => {
    await waitForAppShell();
    await requireTermicApi();

    const pid = findAppPid();
    fact("appPid", pid === null ? "not found" : String(pid));

    // Let startup work drain. Measuring immediately catches bundle parse and
    // store hydration still in flight, which is the "startup noise" trap from
    // the GH #140 harness in a different costume.
    await browser.pause(5_000);

    const baseline = sampleRss(pid);
    record({
      metric: "memory.baseline.appMiB",
      value: baseline.appMiB,
      unit: "MiB",
      note: "Tauri process, 5s after shell",
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
    const perCycle: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      await clickByText("Dashboard");
      await waitForText("HOME FOR YOUR CLI CODING AGENTS");
      await clickByText("History");
      await waitForTextGone("HOME FOR YOUR CLI CODING AGENTS");
      const s = sampleRss(pid);
      if (s.totalMiB !== null) perCycle.push(s.totalMiB);
    }

    // Settle again so the final read is not catching transient churn.
    await browser.pause(5_000);
    const after = sampleRss(pid);

    record({
      metric: "memory.after.totalMiB",
      value: after.totalMiB,
      unit: "MiB",
      note: `after ${CYCLES} view-churn cycles`,
      samples: perCycle,
    });

    const delta =
      after.totalMiB !== null && baseline.totalMiB !== null
        ? Math.round((after.totalMiB - baseline.totalMiB) * 10) / 10
        : null;
    record({
      metric: "memory.growth.totalMiB",
      value: delta,
      unit: "MiB",
      note: `growth across ${CYCLES} cycles; THE row to watch, absolute RSS is runner-dependent`,
    });
    record({
      metric: "memory.growth.perCycleMiB",
      value: delta === null ? null : Math.round((delta / CYCLES) * 100) / 100,
      unit: "MiB",
      note: "per-cycle growth; a steady positive value is the leak signal",
    });
  });
});
