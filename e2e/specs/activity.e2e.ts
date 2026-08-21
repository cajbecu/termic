// Activity monitor (src-tauri/src/procmon.rs + src/components/activity/).
//
// Its own spec file rather than a case inside app.e2e.ts, because it is the
// only feature that opens a SECOND window: the assertions here switch
// WebDriver between window handles, and doing that in the middle of a shared
// 30-case file would leave the wrong window active for whatever ran next.
//
// The feature's whole premise is "measure only while the window is open", so
// the lifecycle assertions matter as much as the numbers: a session that
// outlives its window is a monitor that costs CPU with nobody watching.

import {
  waitForAppShell, waitVisible, clickWhenVisible, openTask, waitForAgentReady,
  archiveTask, snap, requireTermicApi,
} from "../helpers.js";

/** The Activity window's handle, found by its own entry document. One scan
 *  of the open handles; see `waitForActivityHandle` for the polling version —
 *  a freshly created webview shows up as a handle while still on
 *  `about:blank`, so a single scan can legitimately miss it. */
async function activityHandle(): Promise<string | null> {
  for (const h of await browser.getWindowHandles()) {
    await browser.switchToWindow(h);
    const href = await browser.execute(() => location.href);
    if (href.includes("activity.html")) return h;
  }
  return null;
}

/** Wait for the Activity window to exist AND have loaded its document, then
 *  leave WebDriver switched to it. */
async function waitForActivityHandle(): Promise<string> {
  let found: string | null = null;
  await browser.waitUntil(
    async () => {
      found = await activityHandle();
      return found !== null;
    },
    { timeout: 20_000, timeoutMsg: "Activity window never loaded activity.html" },
  );
  await browser.switchToWindow(found!);
  return found!;
}

/** One row's visible text per entry, whitespace collapsed. Assumes WebDriver
 *  is already switched to the Activity window. */
async function activityRows(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="activity-row"]')].map(
      el => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    ),
  );
}

describe("Activity monitor", () => {
  let mainHandle: string;
  let taskId: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    mainHandle = await browser.getWindowHandle();
    // A real agent PTY to report on: the fixture agent is a real process
    // with real children, which is exactly what the sampler rolls up.
    taskId = await openTask("activity-mon");
    await waitForAgentReady(taskId);
    // `waitForAgentReady` returns on the FIRST sign of life, which is usually
    // the banner rather than the OSC title. The title case below asserts that
    // the BRIDGE carries a live title, so the main window has to actually have
    // one before the Activity window opens — otherwise the case is really
    // racing fake-agent.sh's first `set_title`, which is how it flaked in CI.
    // Report what the tab ACTUALLY had. A bare timeout here cannot tell
    // "the fixture never ran" from "it ran but the spawn dropped --name"
    // from "the title was lost before the terminal was listening", and this
    // only ever fails on CI, where guessing costs a round trip per attempt.
    let seen: unknown = null;
    await browser.waitUntil(
      async () => {
        seen = await browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0] as
            { liveTitle?: string; cli?: string; ptyId?: string } | undefined;
          return { liveTitle: t?.liveTitle ?? null, cli: t?.cli ?? null, pty: !!t?.ptyId };
        }, taskId);
        return !!(seen as { liveTitle: string | null }).liveTitle?.includes("activity-mon");
      },
      { timeout: 20_000 },
    ).catch(() => {
      throw new Error(
        `agent never drove its OSC title to the task name — tab was ${JSON.stringify(seen)}`,
      );
    });
  });

  after(async () => {
    await browser.switchToWindow(mainHandle);
    await archiveTask(taskId).catch(() => {});
  });

  it("opens its own window from the sidebar footer", async () => {
    const before = (await browser.getWindowHandles()).length;
    await clickWhenVisible('[data-testid="open-activity"]');
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > before,
      { timeout: 15_000, timeoutMsg: "Activity window never opened" },
    );
    // Left on the Activity window on purpose: the cases below assert its
    // contents, and switching back and forth costs a round trip each way.
    await waitForActivityHandle();
    await waitVisible('[data-testid="activity-pause"]');
    await snap("activity-window.png");
  });

  it("reports the agent under its project and task", async () => {
    // CPU% is a delta, so the first snapshot has none. Wait for a row that
    // has a real reading rather than asserting on the baseline.
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(() => document.body.innerText);
        return text.includes("fixture-repo") && text.includes("activity-mon");
      },
      { timeout: 20_000, timeoutMsg: "project / task grouping never appeared" },
    );
    const rows = await activityRows();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("names the agent row after the tab, not a generic label", async () => {
    // Every unrenamed agent tab used to read "Agent · claude", so two tabs on
    // one CLI were indistinguishable (164136b). The Activity window is its own
    // webview and can't read live tab titles directly, so it ASKS the main
    // window and falls back to a positional "Tab N · claude" until the reply
    // lands. Poll rather than read once: a passing one-shot here would only
    // mean the reply happened to beat us.
    const FALLBACK = /(?:^|\| )(?:Agent|Tab \d+) · /;
    let rows: string[] = [];
    await browser.waitUntil(
      async () => {
        rows = await activityRows();
        // The fixture drives its OSC title to "<glyph> <task name>", the exact
        // text the tab strip shows, so the task slug is what has to land here.
        return rows.some(r => r.includes("activity-mon")) && !FALLBACK.test(rows.join(" | "));
      },
      { timeout: 20_000 },
    // Name what the rows DID say: the two ways this fails (the bridge staying
    // silent, vs. a stray untitled row tripping FALLBACK) are indistinguishable
    // from a bare timeout, and this only reproduces on CI.
    ).catch(() => {
      throw new Error(
        `agent row never took the tab's live title, rows were ${JSON.stringify(rows)}`,
      );
    });
    // Restate it as an assertion so a pass shows what it matched, and a future
    // edit that loosens the poll still has to produce a titled row.
    expect(rows.join(" | ")).toContain("activity-mon");
    expect(rows.join(" | ")).not.toMatch(FALLBACK);
  });

  it("accounts for Termic's own processes", async () => {
    // The app row must be present and must NOT swallow the agents (it is
    // their parent, so a missing stop-set would double-count every one).
    const text = await browser.execute(() => document.body.innerText);
    expect(text).toContain("Termic itself");
  });

  it("shows a real CPU reading once it has two samples", async () => {
    // The harness runs the app offscreen, so this window is `document.hidden`
    // the whole time and samples at the slow period. That it still reports a
    // percentage here is the assertion: an occluded monitor keeps its history
    // going instead of leaving a hole.
    const pct = await browser.waitUntil(
      async () => {
        const cells = await browser.execute(() =>
          [...document.querySelectorAll('[data-testid="activity-row"]')]
            .map(el => (el as HTMLElement).innerText)
            .join(" "),
        );
        // A dash means "not measured yet"; anything with a % has a delta.
        return cells.includes("%") ? cells : false;
      },
      { timeout: 30_000, timeoutMsg: "no row ever reported a CPU percentage" },
    );
    expect(String(pct)).toContain("%");
  });


  it("sorts by any column from its header, CPU descending by default", async () => {
    const state = async () => browser.execute(() =>
      Object.fromEntries(
        ["name", "cpu", "mem", "out", "uptime", "pid"].map(c => [
          c,
          document.querySelector(`[data-testid="activity-sort-${c}"]`)?.getAttribute("data-active") ?? null,
        ]),
      ));

    // Default: the question the window exists to answer.
    expect(await state()).toMatchObject({ cpu: "desc", mem: null, name: null });

    await clickWhenVisible('[data-testid="activity-sort-mem"]');
    // A new column starts biggest-first, and the old one lets go.
    expect(await state()).toMatchObject({ mem: "desc", cpu: null });

    await clickWhenVisible('[data-testid="activity-sort-mem"]');
    expect(await state()).toMatchObject({ mem: "asc" });

    await clickWhenVisible('[data-testid="activity-sort-name"]');
    // The name column reads A-to-Z first, unlike the numeric ones.
    expect(await state()).toMatchObject({ name: "asc", mem: null });

    await clickWhenVisible('[data-testid="activity-sort-pid"]');
    expect(await state()).toMatchObject({ pid: "desc" });
    // The PID column is a column now, not something hidden behind an expander.
    const pids = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="activity-row"]')]
        .map(el => (el as HTMLElement).innerText.trim().split(/\s+/).pop() ?? ""));
    expect(pids.length).toBeGreaterThan(0);
    for (const p of pids) expect(Number(p)).toBeGreaterThan(1);

    await clickWhenVisible('[data-testid="activity-sort-cpu"]');
    expect(await state()).toMatchObject({ cpu: "desc" });
  });

  it("stops sampling while paused and resumes on demand", async () => {
    await clickWhenVisible('[data-testid="activity-pause"]');
    await browser.waitUntil(
      async () => {
        const t = await browser.execute(() => document.body.innerText);
        return t.includes("Paused, nothing is being sampled");
      },
      { timeout: 5_000, timeoutMsg: "pause never took effect" },
    );
    await snap("activity-paused.png");
    await clickWhenVisible('[data-testid="activity-pause"]');
    await browser.waitUntil(
      async () => {
        const t = await browser.execute(() => document.body.innerText);
        return t.includes("Sampling every");
      },
      { timeout: 5_000, timeoutMsg: "resume never took effect" },
    );
  });

  it("re-focuses the existing window instead of opening a second one", async () => {
    const count = (await browser.getWindowHandles()).length;
    await browser.switchToWindow(mainHandle);
    await clickWhenVisible('[data-testid="open-activity"]');
    // Give a rogue second window time to appear before asserting it did not.
    await browser.waitUntil(
      async () => (await browser.execute(() => true)) === true,
      { timeout: 1_000 },
    ).catch(() => {});
    expect((await browser.getWindowHandles()).length).toBe(count);
  });

  it("drops the sampling session when the window closes", async () => {
    await waitForActivityHandle();
    await browser.closeWindow();
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(
      async () => (await activityHandle()) === null,
      { timeout: 10_000, timeoutMsg: "Activity window never went away" },
    );
    await browser.switchToWindow(mainHandle);
    // A fresh session must be grantable: a leaked one would keep the old
    // window's history and (worse) suggest state survived its owner.
    const session = await browser.execute(async () => {
      const t = window.__termic!;
      const snap = await t.invoke("procmon_start");
      await t.invoke("procmon_stop", { session: snap.session });
      return snap.session as number;
    });
    expect(session).toBeGreaterThan(0);
  });

  it("signals only processes that belong to one of our terminals", async () => {
    // `procmon_signal` is the one command here with teeth, and its whole
    // safety story is the ownership check: without it the webview would be an
    // arbitrary kill(2). Both halves are asserted — the refusal AND that a
    // legitimate stop actually lands.
    const refused = await browser.execute(async () => {
      try {
        // launchd. Emphatically not one of our terminals.
        await window.__termic!.invoke("procmon_signal", { pid: 1, signal: "TERM" });
        return "ALLOWED";
      } catch (e: any) {
        return String(e?.message ?? e);
      }
    });
    expect(refused).toContain("not part of a Termic terminal");

    const badSignal = await browser.execute(async () => {
      const t = window.__termic!;
      const spawned = await t.ipc.ptySpawn({
        cwd: "/tmp", cmd: "/bin/sh", args: ["-c", "sleep 30"],
        env: {}, rows: 24, cols: 80, owner: { kind: "shell" },
      });
      // Find our own pid through the sampler, then try an unsupported signal.
      const first = await t.invoke("procmon_start");
      const row = first.rows.find((r: any) => r.ptyId === spawned.id);
      let err = "ALLOWED";
      try {
        await t.invoke("procmon_signal", { pid: row.pid, signal: "USR1" });
      } catch (e: any) {
        err = String(e?.message ?? e);
      }
      // A supported one must work on the same pid, so the refusal above is
      // provably about the signal name and not about ownership.
      await t.invoke("procmon_signal", { pid: row.pid, signal: "TERM" });
      const after = await t.invoke("procmon_sample", { session: first.session });
      await t.invoke("procmon_stop", { session: first.session });
      const stillThere = after.rows.find((r: any) => r.ptyId === spawned.id);
      return { err, pid: row.pid, aliveAfterTerm: stillThere ? stillThere.alive : false };
    });
    expect(badSignal.err).toContain("unsupported signal");
    expect(badSignal.pid).toBeGreaterThan(1);
    expect(badSignal.aliveAfterTerm).toBe(false);
  });

  // Last on purpose: it drives its own sampling session, which would evict
  // the Activity window's one out from under the cases above.
  it("does not double-count the agents inside Termic's own row", async () => {
    // Every PTY is a child of the app process, so a missing stop-set would
    // charge every agent's CPU to Termic as well as to its own task. Asserted
    // through the sampler because process identity has no DOM surface.
    const shape = await browser.execute(async () => {
      const t = window.__termic!;
      const first = await t.invoke("procmon_start");
      const second = await t.invoke("procmon_sample", { session: first.session });
      await t.invoke("procmon_stop", { session: first.session });
      const app = second.rows.find((r: any) => r.kind === "app");
      return {
        appPids: (app?.children ?? []).map((c: any) => c.pid),
        ptyPids: second.rows.filter((r: any) => r.ptyId).map((r: any) => r.pid),
      };
    });
    expect(shape.ptyPids.length).toBeGreaterThan(0);
    for (const pid of shape.ptyPids) {
      expect(shape.appPids).not.toContain(pid);
    }
  });
});
