// Agent work-state, attention and queue flows.
//
// These cases assert on the BADGE the user sees (`[data-testid="work-badge"]`
// in the tab strip and in the sidebar row), not on `tab.workState` in the
// store. The store field is an implementation detail of the detector; the
// badge is the feature. Reading the store here used to let the whole visual
// layer break silently — the spinner could stop rendering and every one of
// these tests would still pass.
//
// Submits go through `submitToAgent`, which drives xterm's own input path, so
// no spec stamps `lastInputAt` by hand any more. Terminal OUTPUT is still read
// from the store (`lastOutputAt`) — xterm paints to a WebGL canvas, so PTY
// bytes are genuinely not in the DOM.

import {
  archiveTask,
  ensureActiveTask,
  openTask,
  queuedCount,
  requireTermicApi,
  requireWorkBadges,
  sidebarBadge,
  snap,
  submitToAgent,
  taskViewBadge,
  waitForAgentReady,
  waitForAppShell,
  waitForWorkBadge,
  waitForWorkBadgeGone,
} from "../helpers";

/** ms since the task's agent tab last produced PTY bytes. Not in the DOM. */
const quietFor = (taskId: string) =>
  browser.execute((id) => {
    const t = window.__termic!.useApp.getState().tabs[id][0];
    return Date.now() - (t.lastOutputAt ?? 0);
  }, taskId);

// P0: after a real submit, termic must SHOW the agent as working. Work
// detection is gated on the tab having been submitted-to since spawn (guards
// against cold-start false positives), which is exactly why the submit goes in
// through the terminal's input path: it arms the detector the way a keystroke
// does, so this covers the arming too.
describe("agent working state", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("shows the working badge after a submit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-agent-working");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "do something");

    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "the tab never showed a working badge after a submit",
    });
    await snap("agent-working.png");
  });
});

// P0: when an agent you're NOT watching finishes, termic must raise attention
// on its tab. Start an agent working, switch to another task so it's
// backgrounded (still mounted), and assert its SIDEBAR row flags completion —
// that row is the only surface a user can see it on while looking elsewhere.
describe("agent attention", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  it("flags a backgrounded agent's completion", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();

    a = await openTask("e2e-attn-a");
    await waitForAgentReady(a);
    await submitToAgent(a, "do something");
    await waitForWorkBadge(a, "working", {
      timeout: 10_000,
      message: "agent A never showed a working badge",
    });

    // Switch to a second task so A is backgrounded (kept mounted).
    b = await openTask("e2e-attn-b");

    await browser.waitUntil(
      async () => {
        const badge = await sidebarBadge(a!);
        return badge === "done" || badge === "attention";
      },
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: "the backgrounded agent's sidebar row never flagged completion",
      },
    );

    await snap("agent-attention.png");
  });
});

// P1: the message queue lets you line up input while an agent is busy; it
// sends on idle. Cases: a message enqueued while working is HELD (the footer
// chip keeps counting it), then DRAINS once the agent goes idle (chip empties
// + the PTY receives it).
describe("message queue", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("holds a message while working, then drains it when idle", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-queue");
    await waitForAgentReady(taskId);

    // Put the agent to work.
    await submitToAgent(taskId, "work");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Enqueue a message WHILE working — it must be held, not sent. Adding it
    // is a store call (the composer lives in a popover; the queue engine, not
    // the popover, is what this case is about), but the assertion is the
    // footer chip's count.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.enqueueAgentMessage(id, s.tabs[id][0].id, "queued-msg");
    }, taskId);
    await browser.waitUntil(async () => (await queuedCount(taskId!)) === 1, {
      timeout: 8_000,
      timeoutMsg: "the queue chip never counted the held message",
    });

    const before = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
      taskId,
    );

    // Once the agent settles to idle, the queue drains: the chip empties and
    // the PTY receives the queued line (new output — canvas, so store-read).
    await browser.waitUntil(
      async () => {
        if ((await queuedCount(taskId!)) !== 0) return false;
        const now = await browser.execute(
          (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
          taskId,
        );
        return now !== before;
      },
      { timeout: 15_000, interval: 300, timeoutMsg: "queue never drained on idle" },
    );

    await snap("message-queue.png");
  });
});

// P2: per-task agent extras. Cases: toggling YOLO mode; opening an aux (bottom)
// terminal for a task.
describe("agent extras", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const task = () =>
    browser.execute(
      (id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id),
      taskId,
    );

  it("toggles YOLO mode on a task", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-extras");
    const before = !!(await task())?.yolo;
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, !b),
      taskId,
      before,
    );
    await browser.waitUntil(async () => !!(await task())?.yolo !== before, {
      timeout: 8_000,
      timeoutMsg: "YOLO never toggled",
    });
    // restore
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, b),
      taskId,
      before,
    );

    // Each toggle asks the live agent's pane whether to restart, and the window
    // has ONE confirm slot, so leaving it up blocks every later dialog in this
    // file (it used to sit over the whole suite). Answer it: "Later".
    //
    // Waited for, not required: toggling and restoring back-to-back can land in
    // a single React commit, and then `effYolo` never changes as far as the
    // pane is concerned, so nothing is asked. The invariant worth asserting is
    // that nothing is left standing, not that something appeared.
    await browser
      .waitUntil(() => browser.execute(() => !!window.__termic!.useUI.getState().confirm),
        { timeout: 5_000, interval: 200 })
      .catch(() => {});
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      if (ui.confirm) ui.resolveConfirm(false);
    });
    expect(await browser.execute(() => !!window.__termic!.useUI.getState().confirm)).toBe(false);
  });

  it("opens an aux (bottom) terminal", async () => {
    await browser.execute(
      (id) => window.__termic!.useApp.getState().addBottomTab(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().bottomTabs[id] ?? []).length >= 1,
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "aux terminal was not added" },
    );
    await snap("agent-extras.png");
  });
});

// P1: the agent registry (Settings → Agent CLIs). Guards disabling/enabling an
// agent CLI through agentsSave. Uses "gemini" (not the test agents) and always
// restores it.
describe("agent settings", () => {
  const AGENT = "gemini";

  const setDisabled = (disabled: boolean) =>
    browser.execute(
      async (id, dis) => {
        const st = window.__termic!.useApp.getState();
        const next = st.agents.map((a: any) =>
          a.id === id ? { ...a, disabled: dis } : a,
        );
        await window.__termic!.ipc.agentsSave(next);
        await st.loadAll();
      },
      AGENT,
      disabled,
    );
  const isDisabled = () =>
    browser.execute(
      (id) =>
        !!window.__termic!.useApp
          .getState()
          .agents.find((a: any) => a.id === id)?.disabled,
      AGENT,
    );

  after(async () => {
    await setDisabled(false);
  });

  it("disables an agent CLI", async () => {
    await waitForAppShell();
    await requireTermicApi();
    expect(await isDisabled()).toBe(false);
    await setDisabled(true);
    await browser.waitUntil(async () => (await isDisabled()) === true, {
      timeout: 8_000,
      timeoutMsg: "agent never became disabled",
    });
  });

  it("re-enables an agent CLI", async () => {
    await setDisabled(false);
    await browser.waitUntil(async () => (await isDisabled()) === false, {
      timeout: 8_000,
      timeoutMsg: "agent never re-enabled",
    });
    await snap("agent-settings.png");
  });
});

// P0: an agent that backgrounds work ends its own turn while the work runs, so
// its title goes to the idle glyph and every byte-stream signal reads
// "finished". Measured against real claude: a done badge held for 617s while
// three subagents worked. The only thing that says otherwise is the agent's own
// status line, so the done is held back while that line is on screen.
describe("pending work defers done", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("holds the done badge while the agent reports work outstanding", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-pending-work");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "#pending 2");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Give every done path a real chance to fire before asserting it did not.
    // Not a fixed sleep: this waits on app state (bytes stopped arriving) past
    // the two thresholds that would otherwise fire — byte-quiet at 4s and the
    // settle timer at 5s. Without clearing those, "still working" would prove
    // nothing.
    await browser.waitUntil(async () => (await quietFor(taskId!)) > 9_000, {
      timeout: 25_000,
      interval: 500,
      timeoutMsg: "PTY never went quiet",
    });

    // Still spinning, and no bell — the hold is a hold, not a swallowed done.
    expect(await taskViewBadge(taskId)).toBe("working");
    await snap("agent-pending-held.png");
  });

  it("fires done once the agent's status line clears", async () => {
    await submitToAgent(taskId!, "#settle");
    await waitForWorkBadgeGone(taskId!, "working", {
      timeout: 25_000,
      interval: 300,
      message: "done never fired after the work landed",
    });
    await snap("agent-pending-settled.png");
  });
});

// P0: the hold above must not be able to pin a tab to "working" forever. A
// status line that never clears (a background shell that outlives the turn, or
// the words still sitting in the tail after the work landed) leaves the screen
// byte-quiet and unchanging, so every demoter either fires into the hold or
// latches itself off. The absolute ceiling is the only thing that outranks the
// hold, and it was unreachable: byte-quiet gave up the tick on a held done, so
// the ceiling below it never ran and the tab stayed "working" until the user
// clicked it. Shortened here via the workDoneCeilingMs debug knob, since the
// real one is ten minutes.
describe("a hold that never clears still ends", () => {
  let taskId: string | undefined;
  const CEILING_MS = 8_000;

  after(async () => {
    await browser.execute(() => localStorage.removeItem("workDoneCeilingMs"));
    if (taskId) await archiveTask(taskId);
  });

  it("force-clears the working state at the absolute ceiling", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    await browser.execute((ms) => localStorage.setItem("workDoneCeilingMs", String(ms)), CEILING_MS);
    taskId = await openTask("e2e-pending-ceiling");
    await waitForAgentReady(taskId);

    // Same drill as the hold spec, and #settle is never sent: the pending line
    // stays on screen for the rest of the test.
    await submitToAgent(taskId, "#pending 2");
    await waitForWorkBadge(taskId, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    await waitForWorkBadgeGone(taskId, "working", {
      timeout: CEILING_MS + 20_000,
      interval: 500,
      message: "the held done never reached the ceiling — tab pinned to working",
    });
    await snap("agent-pending-ceiling.png");
  });
});

// P0: a done we got wrong must not outlive the evidence. Every heuristic here
// can misread a stage boundary in a long multi-stage turn as the end of it, and
// the recovery used to be a click: agent signals could never undo a "done", so
// the tab showed no spinner for the rest of the turn, and the turn's one done
// token was already spent so the real completion badged nothing.
describe("a premature done is taken back", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  // The ONLY case in this file that needs more than mocha's 60s default, and
  // it is raised on purpose rather than left to be killed by it. The fixture
  // burns ~19s that cannot be compressed away: a 16s idle window (it must
  // outlast STICKY_DONE_MS = 8s counted from when the done FIRES, ~6s in, or
  // stage 2's busy signal is ignored as post-answer glyph flicker), plus
  // stage 2 and the settle. Six sequential waits sit on top. Left at 60s, the
  // last waits are unreachable: a stall gets killed mid-wait with mocha's
  // generic "timeout of 60000ms exceeded" and no clue which signal never
  // arrived. Raised, each wait reaches its own bound — so a stall FAILS FASTER
  // (at the wait that broke) and names what it was waiting for.
  it("returns to working, then still fires the real done", async function () {
    this.timeout(95_000);
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();

    a = await openTask("e2e-stage-a");
    await waitForAgentReady(a);

    // Task B exists BEFORE the submit. A's done only badges while nobody is
    // watching it (a focused tab's done is downgraded to idle on the spot), so
    // A has to be backgrounded before stage 1 ends — and creating a task takes
    // ~1.5s, which used to race the fixture's stage-1 spinner. The fixture
    // padded that spinner to 6s to cover the race. Creating B up front makes
    // backgrounding a sub-millisecond store call instead, so there is nothing
    // left to race and the fixture's padding could go (see `#stage` in
    // scripts/fake-agent.sh).
    b = await openTask("e2e-stage-b");
    await ensureActiveTask(a);

    await submitToAgent(a, "#stage");
    await waitForWorkBadge(a, "working", {
      timeout: 10_000,
      message: "agent never showed a working badge",
    });

    // Background A. From here on the sidebar row is the surface under test.
    await ensureActiveTask(b);

    await browser.waitUntil(async () => (await sidebarBadge(a!)) === "done", {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: "the premature done never showed in the sidebar",
    });

    // Stage 2 starts. The spinner has to come back on its own, and the wrong
    // bullet has to go with it — a spinner is what the sidebar shows only once
    // the done AND its bell are gone (attention outranks both).
    await browser.waitUntil(async () => (await sidebarBadge(a!)) === "working", {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: "the sidebar row never went back to a working badge",
    });

    // And the turn's real ending still has a done to spend.
    await browser.waitUntil(
      async () => {
        const badge = await sidebarBadge(a!);
        return badge === "done" || badge === "attention";
      },
      { timeout: 15_000, interval: 300, timeoutMsg: "the real completion badged nothing" },
    );
    await snap("agent-stage-recovered.png");
  });
});

// P0: an agent asking for the user must raise ATTENTION, not "done". Claude
// sends this ~6s after its title goes idle, i.e. always just behind our own
// done paths, so attention has to be able to land on top of a done we already
// fired. It also sends a second, non-actionable notification a minute after any
// turn you don't reply to; badging that would ring a bell for finished work.
describe("agent notifications", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("raises attention with the agent's own wording", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await requireWorkBadges();
    taskId = await openTask("e2e-agent-notify");
    await waitForAgentReady(taskId);

    await submitToAgent(taskId, "#osc9 FakeAgent needs your permission");

    // The bell is the visible half.
    await waitForWorkBadge(taskId, "attention", {
      timeout: 15_000,
      message: "OSC 9 never raised an attention badge",
    });
    // The agent's own wording is carried on the notification, which has no DOM
    // surface of its own (it goes to the OS notifier), so read it from state.
    const message = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].unread?.message ?? null,
      taskId,
    );
    expect(message).toBe("FakeAgent needs your permission");
    await snap("agent-notify-attention.png");
  });

  it("ignores the idle nag that claude sends after every unanswered turn", async () => {
    // Clear the previous badge the way focus/typing does, so a stale one can't
    // make this pass.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);
    expect(await taskViewBadge(taskId!)).not.toBe("attention");

    await submitToAgent(taskId!, "#osc9 FakeAgent is waiting for your input");

    // Prove the directive was consumed (the PTY echoed past it) rather than
    // asserting on a race: bytes must have flowed after the send.
    await browser.waitUntil(async () => (await quietFor(taskId!)) > 6_000, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "PTY never went quiet after the nag",
    });

    expect(await taskViewBadge(taskId!)).not.toBe("attention");
    expect(await sidebarBadge(taskId!)).not.toBe("attention");
  });
});
