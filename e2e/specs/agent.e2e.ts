import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// P0: after a real submit, termic must show the agent as "working". Work
// detection is gated on the tab having been submitted-to since spawn (guards
// against cold-start false positives), so we stamp lastInputAt (what the app's
// send path does) before the claude-like fake agent flips to its spinner title.
describe("agent working state", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("enters the working state after a submit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-agent-working");

    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0];
          return !!t?.ptyId;
        }, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Arm the submit (stamp lastInputAt, as the real send path does) and send
    // a prompt line so the fake agent flips to its working/spinner title.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("do something\r")),
      );
    }, taskId);

    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().tabs[id][0].workState ===
            "working",
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "agent never entered the working state" },
    );

    await snap("agent-working.png");
  });
});

// P0: when an agent you're NOT watching finishes, termic must raise attention
// (unread / done) on its tab. Start an agent working, switch to another task so
// it's backgrounded (still mounted), and assert it flags completion.
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

    a = await openTask("e2e-attn-a");
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0];
          return !!t?.ptyId;
        }, a),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent A PTY never spawned" },
    );

    // Submit a prompt so the agent goes to work.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("do something\r")),
      );
    }, a);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().tabs[id][0].workState ===
            "working",
          a,
        ),
      { timeout: 10_000, timeoutMsg: "agent A never started working" },
    );

    // Switch to a second task so A is backgrounded (kept mounted).
    b = await openTask("e2e-attn-b");

    // A should flag completion: unread attention set, or workState -> done.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = window.__termic!.useApp.getState().tabs[id][0];
          return !!t.unread || t.workState === "done";
        }, a),
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: "backgrounded agent never flagged completion",
      },
    );

    await snap("agent-attention.png");
  });
});

// P1: the message queue lets you line up input while an agent is busy; it
// sends on idle. Cases: a message enqueued while working is HELD (not sent),
// then DRAINS once the agent goes idle (queue empties + the PTY receives it).
describe("message queue", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const tab = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0],
      taskId,
    );

  it("holds a message while working, then drains it when idle", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-queue");
    await browser.waitUntil(async () => !!(await tab())?.ptyId, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: "agent PTY never spawned",
    });

    // Put the agent to work (armed submit).
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const t = s.tabs[id][0];
      s.patchTab(id, t.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        t.ptyId,
        Array.from(new TextEncoder().encode("work\r")),
      );
    }, taskId);
    await browser.waitUntil(async () => (await tab())?.workState === "working", {
      timeout: 10_000,
      timeoutMsg: "agent never started working",
    });

    // Enqueue a message WHILE working — it must be held, not sent.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.enqueueAgentMessage(id, s.tabs[id][0].id, "queued-msg");
    }, taskId);
    expect((await tab())?.queue?.length ?? 0).toBeGreaterThanOrEqual(1);

    const before = (await tab())?.lastOutputAt ?? 0;

    // Once the agent settles to idle, the queue drains: it empties and the
    // PTY receives the queued line (new output).
    await browser.waitUntil(
      async () => {
        const t = await tab();
        return (t?.queue?.length ?? 0) === 0 && (t?.lastOutputAt ?? 0) !== before;
      },
      { timeout: 20_000, interval: 300, timeoutMsg: "queue never drained on idle" },
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

    // Each toggle asks the live agent's pane whether to restart. The window has
    // ONE confirm slot, so leaving it up blocks every later dialog in this file
    // (it used to sit over the rest of the suite). Answer it: "Later".
    await browser.waitUntil(
      () => browser.execute(() => !!window.__termic!.useUI.getState().confirm),
      { timeout: 8_000, interval: 200, timeoutMsg: "the YOLO restart prompt never appeared" },
    );
    await browser.execute(() => window.__termic!.useUI.getState().resolveConfirm(false));
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

  const submit = (id: string, text: string) =>
    browser.execute((wid, line) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[wid][0];
      s.patchTab(wid, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode(line + "\r")),
      );
    }, id, text);

  const tab0 = (id: string) =>
    browser.execute((wid) => {
      const t = window.__termic!.useApp.getState().tabs[wid][0];
      return { workState: t.workState, unread: t.unread ?? null, lastOutputAt: t.lastOutputAt ?? 0 };
    }, id);

  it("holds the done badge while the agent reports work outstanding", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-pending-work");

    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    await submit(taskId!, "#pending 2");
    await browser.waitUntil(
      async () => (await tab0(taskId!)).workState === "working",
      { timeout: 10_000, timeoutMsg: "agent never started working" },
    );

    // Give every done path a real chance to fire before asserting it did not.
    // Not a fixed sleep: this waits on app state (bytes stopped arriving) past
    // the two thresholds that would otherwise fire — byte-quiet at 4s and the
    // settle timer at 5s. Without clearing those, "still working" would prove
    // nothing.
    await browser.waitUntil(
      async () => Date.now() - (await tab0(taskId!)).lastOutputAt > 9_000,
      { timeout: 30_000, interval: 500, timeoutMsg: "PTY never went quiet" },
    );

    const held = await tab0(taskId!);
    expect(held.workState).toBe("working");
    expect(held.unread).toBeNull();
    await snap("agent-pending-held.png");
  });

  it("fires done once the agent's status line clears", async () => {
    await submit(taskId!, "#settle");
    await browser.waitUntil(
      async () => {
        const t = await tab0(taskId!);
        return t.workState === "done" || t.workState === "idle" || !!t.unread;
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "done never fired after the work landed" },
    );
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
    await browser.execute((ms) => localStorage.setItem("workDoneCeilingMs", String(ms)), CEILING_MS);
    taskId = await openTask("e2e-pending-ceiling");

    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Same drill as the hold spec, and #settle is never sent: the pending line
    // stays on screen for the rest of the test.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("#pending 2\r")),
      );
    }, taskId);

    await browser.waitUntil(
      () => browser.execute((id) => window.__termic!.useApp.getState().tabs[id][0].workState === "working", taskId),
      { timeout: 10_000, timeoutMsg: "agent never started working" },
    );

    await browser.waitUntil(
      () => browser.execute((id) => window.__termic!.useApp.getState().tabs[id][0].workState !== "working", taskId),
      {
        timeout: CEILING_MS + 20_000,
        interval: 500,
        timeoutMsg: "the held done never reached the ceiling — tab pinned to working",
      },
    );
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

  const state = (id: string) =>
    browser.execute((wid) => {
      const t = window.__termic!.useApp.getState().tabs[wid][0];
      return { workState: t.workState, unread: t.unread ?? null };
    }, id);

  it("returns to working, then still fires the real done", async () => {
    await waitForAppShell();
    await requireTermicApi();

    a = await openTask("e2e-stage-a");
    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId, a),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("#stage\r")),
      );
    }, a);
    await browser.waitUntil(
      async () => (await state(a!)).workState === "working",
      { timeout: 10_000, timeoutMsg: "agent never started working" },
    );

    // Background it so a done actually badges (a focused tab's done is
    // downgraded to idle on the spot — nothing to take back).
    b = await openTask("e2e-stage-b");

    await browser.waitUntil(
      async () => (await state(a!)).workState === "done",
      { timeout: 20_000, interval: 300, timeoutMsg: "the premature done never fired" },
    );

    // Stage 2 starts. The spinner has to come back on its own.
    await browser.waitUntil(
      async () => (await state(a!)).workState === "working",
      { timeout: 25_000, interval: 300, timeoutMsg: "the tab never went back to working" },
    );
    expect((await state(a!)).unread).toBeNull(); // the wrong bullet went with it

    // And the turn's real ending still has a done to spend.
    await browser.waitUntil(
      async () => {
        const t = await state(a!);
        return t.workState === "done" || !!t.unread;
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "the real completion fired nothing" },
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

  const send = (id: string, text: string) =>
    browser.execute((wid, line) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[wid][0];
      s.patchTab(wid, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode(line + "\r")),
      );
    }, id, text);

  it("raises attention with the agent's own wording", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-agent-notify");

    await browser.waitUntil(
      () => browser.execute((id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    await send(taskId!, "#osc9 FakeAgent needs your permission");

    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const u = window.__termic!.useApp.getState().tabs[id][0].unread;
          return u?.reason === "attention" && u?.message === "FakeAgent needs your permission";
        }, taskId),
      { timeout: 15_000, interval: 250, timeoutMsg: "OSC 9 never raised attention with its body" },
    );
    await snap("agent-notify-attention.png");
  });

  it("ignores the idle nag that claude sends after every unanswered turn", async () => {
    // Clear the previous badge the way focus/typing does, so a stale one can't
    // make this pass.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.clearAttention(id, s.tabs[id][0].id);
    }, taskId);

    await send(taskId!, "#osc9 FakeAgent is waiting for your input");

    // Prove the directive was consumed (the PTY echoed past it) rather than
    // asserting on a race: bytes must have flowed after the send.
    await browser.waitUntil(
      async () => {
        const t = await browser.execute(
          (id) => window.__termic!.useApp.getState().tabs[id][0],
          taskId,
        );
        return Date.now() - (t.lastOutputAt ?? 0) > 6_000;
      },
      { timeout: 30_000, interval: 500, timeoutMsg: "PTY never went quiet after the nag" },
    );

    const u = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].unread ?? null,
      taskId,
    );
    expect(u?.reason).not.toBe("attention");
  });
});
