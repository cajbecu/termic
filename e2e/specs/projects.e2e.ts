import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clickByText, clickMenuItemUntil, clickWhenVisible, dismissOverlays, pointerDrag, requireTermicApi, keysIn, snap, waitForAppShell, waitForText, waitGone, waitVisible } from "../helpers";

// P1: adding/removing a project. Cases: a git repo can be added as a project
// (shows in the store); removing it drops it. Uses a throwaway temp repo and
// cleans it up.
describe("project add/remove", () => {
  let dir = "";
  let projectId: string | null = null;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-proj-"));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(async () => {
    if (projectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, projectId);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a git repo as a project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const proj = await browser.execute(
      async (d) => await window.__termic!.ipc.projectAdd(d),
      dir,
    );
    projectId = (proj as any).id;
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().projects.some((p: any) => p.id === id),
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "added project never appeared" },
    );
  });

  // The dashed "New task" placeholder stands in for the task rows an empty
  // project does not have yet, so it must be the same height as one. It used
  // to be ~11px taller, which broke the sidebar rhythm.
  it("sizes the empty-project placeholder like a task row", async () => {
    const id = projectId!;
    await browser.execute((i) => {
      window.__termic!.useApp.getState().setProjectCollapsed(i, false);
    }, id);
    const trigger = `[data-testid="project-empty-new-task-${id}"]`;
    await waitVisible(trigger);
    const placeholderH = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).offsetHeight,
      trigger,
    );

    const taskId = await browser.execute(async (i) => {
      const t = window.__termic!;
      const task = await t.ipc.taskOpenRepo(i, "fakeagent", "placeholder-size");
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, id);
    const row = `[data-sidebar-task-id="${taskId}"]`;
    await waitVisible(row);
    const rowH = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).offsetHeight,
      row,
    );

    expect(placeholderH).toEqual(rowH);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskArchive(i);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
  });

  it("reorders projects", async () => {
    // Put the newly-added project first, then restore original order.
    const ids = await browser.execute(
      () => window.__termic!.useApp.getState().projects.map((p: any) => p.id),
      );
    const reordered = [
      projectId!,
      ...(ids as string[]).filter((i) => i !== projectId),
    ];
    await browser.execute(async (order) => {
      await window.__termic!.ipc.projectReorder(order);
      await window.__termic!.useApp.getState().loadAll();
    }, reordered);
    await browser.waitUntil(
      () =>
        browser.execute(
          (first) => window.__termic!.useApp.getState().projects[0]?.id === first,
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "project order never changed" },
    );
  });

  it("assigns the project to a group", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectSetGroup([i], "e2e-group");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.group === "e2e-group",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project group never applied" },
    );
  });

  it("renames the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRename(i, "e2e-renamed-proj");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.name === "e2e-renamed-proj",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project name never updated" },
    );
  });

  it("removes the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRemove(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp.getState().projects.some((p: any) => p.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "removed project still present" },
    );
    projectId = null;
    await snap("project.png");
  });
});

// P2: repo discovery (Add Project → Discover). Scans a folder and returns the
// git repos in it.
describe("discover repos", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-discover-"));
    const sub = path.join(dir, "sub-repo");
    mkdirSync(sub, { recursive: true });
    execSync(`git -C "${sub}" init -q`);
    execSync(
      `git -C "${sub}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a git repo inside a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const repos = await browser.execute(
      async (d) => await window.__termic!.ipc.discoverRepos(d),
      dir,
    );
    expect(
      (repos as any[]).some((r) => JSON.stringify(r).includes("sub-repo")),
    ).toBe(true);
    await snap("discover.png");
  });
});

// P2: importing an existing worktree (issue #5). Guards the discovery half:
// listing worktrees that exist on disk but aren't open as tasks. The fixture
// repo has a pre-seeded `sbcheck` worktree. (We only assert discovery — doing
// the import + archive would rm the shared worktree.)
describe("import worktree", () => {
  it("lists importable worktrees for the project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const list = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      return await window.__termic!.ipc.taskImportableWorktrees(proj.id);
    });
    expect(Array.isArray(list)).toBe(true);
    expect(
      (list as any[]).some((w) => JSON.stringify(w).includes("sbcheck")),
    ).toBe(true);
    await snap("import-worktree.png");
  });
});

// P2: per-repo config (.termic.yaml). Save a config field and read it back.
// Git-cleans the written .termic.yaml on teardown.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("repo config", () => {
  after(() => {
    try {
      execSync(`git -C "${fixture}" clean -fd`);
      execSync(`git -C "${fixture}" checkout -- .termic.yaml`, { stdio: "ignore" });
    } catch {
      /* nothing to restore */
    }
  });

  it("saves a repo config and reads it back", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const loaded = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      // Load returns null when there's no .termic.yaml yet; scaffold a default.
      let cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      if (!cfg) {
        await window.__termic!.ipc.repoConfigScaffold(proj.id);
        cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      }
      cfg.scripts.setup = "echo e2e-setup";
      await window.__termic!.ipc.repoConfigSave(proj.id, cfg);
      return await window.__termic!.ipc.repoConfigLoad(proj.id);
    });
    expect((loaded as any).scripts.setup).toBe("echo e2e-setup");
    await snap("repo-config.png");
  });
});

// P1: which branch a new worktree task is cut from (`Project.base_branch` + the
// "Branch from" picker in the project `+` menu). Before this, the quick path
// always used a base detected as origin/main at add time, with nothing on
// screen saying so, which is wrong for anyone whose features come off a
// long-lived `dev`. The model is deliberately ONE concept: pick a branch, it's
// remembered as the project's base.
//
// Uses its OWN temp repo, not the shared fixture: these cases move HEAD around,
// and the fixture's checked-out branch is load-bearing for other spec files.
//
// Every branch points at a DIFFERENT commit on purpose. If any two shared a
// tip, most of these cases would pass against a wrong implementation:
//   main = origin/main = <mainSha>   what add-time detection picks
//   dev  = <devSha>                  ahead of main; HEAD sits here throughout
//   feat = <featSha>                 off main; a third pin target
describe("branch new tasks from", () => {
  let dir = "";
  let projectId = "";
  let mainSha = "";
  let devSha = "";
  let featSha = "";
  const createdTaskIds: string[] = [];

  /** Tip of `ref` in the temp repo. The worktree branch a task creates lives
   *  here too, so this is how we prove where it was cut from. */
  const rev = (ref: string) =>
    execSync(`git -C "${dir}" rev-parse ${ref}`).toString().trim();

  /** Create a worktree task and return the sha its branch points at. */
  const createTaskAt = async (name: string, base: string | null) => {
    const task = await browser.execute(
      async (pid, n, b) => {
        const t = await window.__termic!.ipc.taskCreate({
          project_id: pid,
          name: n,
          cli: "fakeagent",
          base_branch: b,
          branch: n,
        });
        await window.__termic!.useApp.getState().loadAll();
        return t;
      },
      projectId,
      name,
      base,
    );
    createdTaskIds.push((task as any).id);
    return rev(name);
  };

  /** Pin a base on the project, exactly as the picker does. */
  const pinBase = async (branch: string) => {
    await browser.execute(
      async (id, b) => {
        const t = window.__termic!;
        const p = t.useApp.getState().projects.find((x: any) => x.id === id);
        await t.ipc.projectUpdate({ ...p, base_branch: b });
        await t.useApp.getState().loadAll();
      },
      projectId,
      branch,
    );
  };

  /** The project's stored base, read back from the store. */
  const storedBase = async () =>
    (await browser.execute(
      (id) =>
        window.__termic!.useApp.getState().projects.find((p: any) => p.id === id)
          ?.base_branch,
      projectId,
    )) as string;

  const checkout = (branch: string) => execSync(`git -C "${dir}" checkout -q ${branch}`);

  /** The open new-task menu's visible text. Takes the first menu with a real
   *  box, not the first in the DOM: Radix leaves a closing menu mounted until
   *  its animation ends, and animations are frozen while the window is
   *  occluded (which the harness always is), so a zero-sized husk can sit in
   *  front of the menu this actually means. */
  const menuText = async () =>
    (await browser.execute(() => {
      const m = [...document.querySelectorAll('[role="menu"]')].find(
        (e) => e.getBoundingClientRect().width > 0,
      ) as HTMLElement | null;
      return m?.innerText ?? "";
    })) as string;

  /** Wait for the menu to finish re-rendering into `mode` before clicking
   *  anything in it.
   *
   *  The mode is remembered app-wide, so clicking "Worktree" / "Main checkout"
   *  usually CHANGES it, and the menu then re-renders to add or drop its
   *  "Branch from" row. An item clicked into that re-render lands on a node
   *  Radix is replacing and is simply lost: no name prompt, no task, and only
   *  on a machine slow enough to put the click inside the window — i.e. CI.
   *  5eff3f3 fixed exactly this for the main-checkout case; the worktree ones
   *  had the same hole. */
  const settleMenuMode = async (mode: "worktree" | "main") => {
    const wantsBranchFrom = mode === "worktree";
    const label = mode === "worktree" ? "Worktree" : "Main checkout";
    await browser.waitUntil(
      async () => {
        const text = await menuText();
        // The menu must EXIST, not merely lack the row. Radix remounts the
        // content while the mode flips, so there is a beat where the query
        // finds nothing — and "" trivially satisfies "no Branch from row",
        // which let the main-checkout case settle on a menu that was not
        // there yet and click into the remount.
        if (text.length === 0) return false;
        if (text.includes("Branch from") === wantsBranchFrom) return true;
        // Still on the other mode: the toggle click can be lost to the same
        // remount as the items are, and then this would just wait out its
        // timeout on a mode nothing is going to change. Click it again. The
        // buttons are idempotent (they set a mode, they do not flip one), so a
        // repeat is free.
        await browser.execute((t) => {
          const el = [...document.querySelectorAll('[role="menu"] button')].find(
            (e) => e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
          );
          if (el) (el as HTMLElement).click();
        }, label);
        return false;
      },
      { timeout: 8_000, interval: 250, timeoutMsg: `the menu never settled into ${mode} mode` },
    );
  };

  /** Alphabetical on purpose: "bitbucket" must sort before "origin". */
  const remotes = ["bitbucket", "origin"];
  const remotePath = (r: string) =>
    path.join(dir, "..", `${path.basename(dir)}-${r}.git`);

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-base-"));
    const g = (args: string) => execSync(`git -C "${dir}" ${args}`, { stdio: "ignore" });
    const commit = (msg: string) =>
      g(`-c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m ${msg}`);

    execSync(`git -C "${dir}" init -q -b main`);
    commit("base");
    // TWO remotes, and "bitbucket" sorts BEFORE "origin". `git remote` lists
    // alphabetically, so taking its first line pinned a stale remote as the
    // project base at add time. Real origins also matter on their own: without
    // one, resolve_base_ref falls back to local main and the policy-off case
    // would pass for the wrong reason.
    for (const r of remotes) {
      const bare = remotePath(r);
      execSync(`git init --bare -q -b main "${bare}"`);
      g(`remote add ${r} "${bare}"`);
      g(`push -q ${r} main`);
      // `push` does NOT write refs/remotes/<r>/HEAD; only clone or an explicit
      // set-head does. Needed so the alias-filtering assertion isn't vacuous.
      g(`remote set-head ${r} -a`);
    }
    mainSha = rev("main");

    // Move HEAD off the default onto a branch that is strictly AHEAD, so
    // "current branch" and "project default" can never be confused.
    g(`checkout -q -b dev`);
    commit("dev-work");
    devSha = rev("dev");

    // A third tip, so "re-read HEAD at create time" can be told apart from
    // "resolved once when the policy was switched on".
    g(`checkout -q -b feat main`);
    commit("feat-work");
    featSha = rev("feat");
    g(`checkout -q dev`);

    expect(new Set([mainSha, devSha, featSha]).size).toBe(3);
  });

  after(async () => {
    for (const id of createdTaskIds) {
      await browser
        .execute(async (i) => {
          await window.__termic!.ipc.taskDelete(i);
          await window.__termic!.useApp.getState().loadAll();
        }, id)
        .catch(() => {});
    }
    if (projectId) {
      await browser
        .execute(async (id) => {
          await window.__termic!.ipc.projectRemove(id);
          await window.__termic!.useApp.getState().loadAll();
        }, projectId)
        .catch(() => {});
    }
    for (const r of remotes) rmSync(remotePath(r), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the repo and reports its branch context", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const proj = await browser.execute(
      async (d) => {
        const p = await window.__termic!.ipc.projectAdd(d);
        await window.__termic!.useApp.getState().loadAll();
        return p;
      },
      dir,
    );
    projectId = (proj as any).id;
    // origin wins over the alphabetically-first "bitbucket", and the branch
    // comes from that remote's own HEAD alias.
    expect((proj as any).base_branch).toBe("origin/main");

    const ctx = await browser.execute(
      async (id) => await window.__termic!.ipc.projectBranchContext(id),
      projectId,
    );
    // The picker needs the live HEAD plus BOTH ref namespaces: the default it
    // has to render as selected ("origin/main") is remote-tracking, which
    // project_git_branches never returns.
    expect((ctx as any).head).toBe("dev");
    expect((ctx as any).local).toEqual(expect.arrayContaining(["main", "dev"]));
    expect((ctx as any).remote).toEqual(
      expect.arrayContaining(["origin/main", "bitbucket/main"]),
    );
    // The symbolic <remote>/HEAD aliases are filtered out. They shorten to a
    // BARE remote name ("origin"), not "origin/HEAD", so assert on that shape:
    // a bare entry here is an alias leaking into the picker as a fake branch.
    expect((ctx as any).remote.filter((r: string) => !r.includes("/"))).toEqual([]);
  });

  // HEAD sits on `dev` throughout these, so anything that wrongly cuts from
  // the checkout instead of the pin lands on devSha and fails.
  it("branches from the pinned base, not the checked-out branch", async () => {
    expect(await createTaskAt("e2e-base-pin", null)).toBe(mainSha);
  });

  it("treats a blank explicit base as absent, not as HEAD", async () => {
    // Regression guard: `unwrap_or_else` alone let Some("") through, and an
    // empty base resolves to "HEAD" in resolve_base_ref — a silent cut from
    // wherever the repo happened to be sitting.
    expect(await createTaskAt("e2e-base-blank", "   ")).toBe(mainSha);
  });

  it("lets an explicit per-task base outrank the pin", async () => {
    // The New Task dialog's "Branch from" field and the CLI's `base` arg.
    expect(await createTaskAt("e2e-base-explicit", "feat")).toBe(featSha);
    // ...without disturbing what the project remembers.
    expect(await storedBase()).toBe("origin/main");
  });

  it("remembers a newly picked base and uses it for the next task", async () => {
    // The whole model in one case: pick, it sticks, it's what you get.
    await pinBase("feat");
    expect(await storedBase()).toBe("feat");
    expect(await createTaskAt("e2e-base-repinned", null)).toBe(featSha);

    // Re-pinning replaces, it doesn't accumulate modes.
    await pinBase("dev");
    expect(await createTaskAt("e2e-base-repinned-2", null)).toBe(devSha);
  });

  it("keeps the pin fixed when the checkout moves", async () => {
    // The deliberate trade-off of dropping the follow-HEAD mode: the base is
    // yours, and moving the main checkout must NOT silently change it.
    await pinBase("main");
    checkout("feat");
    expect(await createTaskAt("e2e-base-stable", null)).toBe(mainSha);
    checkout("dev");
    expect(await storedBase()).toBe("main");
  });

  it("shows the base in the project menu, worktree mode only", async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    // Radix opens on pointerdown, so a bare .click() isn't enough.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');

    // Mode is remembered app-wide, so don't assume where we start: drive it.
    // Main checkout runs on the live branch, so there's no base to pick.
    await clickByText("Main checkout");
    await settleMenuMode("main");

    await clickByText("Worktree");
    await settleMenuMode("worktree");
    // The row names the PINNED base ("main" from the previous case), which is
    // the disclosure the quick path never had. HEAD is on `dev`, so a row
    // reading "dev" would mean the base is following the checkout again.
    expect(await menuText()).toContain("main");
    await snap("branch-from.png");
    await browser.keys("Escape");
  });

  // Terminal used to bypass the inline name prompt in main-checkout mode
  // (create-at-once, Rust auto-names it), unlike every other item in this
  // menu. It now goes through the same prompt as the agent items.
  it("prompts for a name before creating a main-checkout Terminal task", async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
    await clickByText("Main checkout");
    await settleMenuMode("main");
    await clickMenuItemUntil("Terminal", 'input[placeholder="Task name"]');

    // Menu closes, an inline name input takes its place instead of a task
    // appearing immediately.
    const nameInput = 'input[placeholder="Task name"]';
    await waitVisible(nameInput);
    const prefilled = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLInputElement).value,
      nameInput,
    );
    expect(prefilled).toMatch(/^terminal-\d+$/);

    await keysIn(nameInput, "Enter");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (pid, n) =>
            window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.project_id === pid && t.name === n),
          projectId,
          prefilled,
        ),
      { timeout: 8_000, timeoutMsg: "named main-checkout terminal task never appeared" },
    );
    const created = await browser.execute(
      (pid, n) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.project_id === pid && t.name === n),
      projectId,
      prefilled,
    );
    createdTaskIds.push((created as any).id);
  });

  // GH #242: the sidebar's quick-create row is a SECOND worktree-creation
  // implementation, separate from NewTaskDialog, and used to block behind
  // its own overlay (QuickCreateProgressDialog) the same way the modal did.
  // Prove the inline row commits without blocking too: the menu/name-input
  // closes immediately, well before the worktree is actually ready, and the
  // task still lands on its own branch.
  it("creates a worktree task from the inline quick-create row without blocking", async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
    await clickByText("Worktree");
    await settleMenuMode("worktree");
    await clickMenuItemUntil("Terminal", 'input[placeholder="Task name"]');

    const nameInput = 'input[placeholder="Task name"]';
    await waitVisible(nameInput);
    await browser.execute((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-quick-wt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, nameInput);
    await keysIn(nameInput, "Enter");

    // The inline row (name + branch inputs) is gone right away — it does not
    // wait for `git worktree add` to finish, same fix as the dialog case in
    // task.e2e.ts.
    await waitGone(nameInput, 2_000);

    // ...and the worktree still lands once it's actually ready, on its own
    // branch (not the main checkout).
    await browser.waitUntil(
      () =>
        browser.execute(
          (pid) =>
            window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.project_id === pid && t.name === "e2e-quick-wt"),
          projectId,
        ),
      { timeout: 15_000, timeoutMsg: "quick-create worktree task never landed after the row closed early" },
    );
    const created = await browser.execute(
      (pid) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.project_id === pid && t.name === "e2e-quick-wt"),
      projectId,
    );
    expect((created as any).is_main_checkout).not.toBe(true);
    createdTaskIds.push((created as any).id);
  });

  it("offers one flat branch list, pin checked and HEAD marked", async () => {
    // The pin lives IN the list rather than in a separate "Project default"
    // row, so there's one place to look. Mode is remembered app-wide (the
    // previous case left it on Main checkout), so drive it rather than
    // assume where we start.
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
    await clickByText("Worktree");
    await settleMenuMode("worktree");

    // Radix submenus open on hover; the trigger carries aria-haspopup.
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')].find((e) =>
        e.textContent?.includes("Branch from"),
      ) as HTMLElement | undefined;
      if (!t) throw new Error('no "Branch from" submenu trigger');
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });

    // Every ref is offered in ONE list, including the pinned one.
    const items = async () =>
      (await browser.execute(() =>
        [...document.querySelectorAll('[role="menuitem"]')]
          .map((e) => (e as HTMLElement).innerText.trim())
          .filter(Boolean),
      )) as string[];
    await browser.waitUntil(
      async () => (await items()).some((t) => t.startsWith("origin/main")),
      { timeout: 8_000, timeoutMsg: "branch list never rendered" },
    );

    const list = await items();
    for (const b of ["main", "dev", "origin/main", "bitbucket/main"]) {
      expect(list.some((t) => t.split("\n")[0] === b)).toBe(true);
    }
    // The current branch is a HINT on its row, not a separate mode/entry.
    expect(list.some((t) => t.startsWith("dev") && t.includes("current"))).toBe(true);
    expect(list.some((t) => t === "Current branch")).toBe(false);
    expect(list.some((t) => t.startsWith("Project default"))).toBe(false);
    await snap("branch-list.png");
    await browser.keys("Escape");
  });
});

// P1: sidebar drags (pointer-based, see helpers.pointerDrag). Cases: reorder
// two projects; drop a project into a group folder; reorder a whole folder as
// a block. All three run through the same Sidebar pointer handler but land in
// different IPC calls (project_reorder / project_set_group), so each asserts on
// the store after the drop.
describe("sidebar project drag", () => {
  const dirs: string[] = [];
  const ids: string[] = [];
  // Uppercase on purpose: the sidebar renders (and writes back) group labels
  // uppercased, so this is the key the DOM and the store both use.
  const GROUP = "E2E-GROUP";

  before(() => {
    for (let i = 0; i < 2; i++) {
      const d = mkdtempSync(path.join(os.tmpdir(), "e2e-drag-"));
      execSync(
        `git -C "${d}" init -q && git -C "${d}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
      );
      dirs.push(d);
    }
  });
  after(async () => {
    for (const id of ids) {
      await browser.execute(async (i) => {
        await window.__termic!.ipc.projectRemove(i);
      }, id);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // Project ids in sidebar order.
  const order = () =>
    browser.execute(() =>
      window.__termic!.useApp.getState().projects.map((p: any) => p.id as string),
    );
  const groupOf = (id: string) =>
    browser.execute(
      (i) =>
        (window.__termic!.useApp.getState().projects.find((p: any) => p.id === i)
          ?.group ?? null) as string | null,
      id,
    );
  const row = (id: string) => `[data-project-id="${id}"]`;

  it("reorders two projects by dragging one above the other", async () => {
    await waitForAppShell();
    await requireTermicApi();
    // Earlier cases in this file open dialogs; a lingering backdrop would eat
    // the drag's hit testing.
    await dismissOverlays();
    for (const d of dirs) {
      const proj = await browser.execute(
        async (dir) => await window.__termic!.ipc.projectAdd(dir),
        d,
      );
      ids.push((proj as any).id);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    const [a, b] = ids;
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.includes(a) && o.includes(b);
      },
      { timeout: 8_000, timeoutMsg: "the new projects never reached the sidebar" },
    );
    await waitVisible(row(b));
    expect(((await order()) as string[]).indexOf(a)).toBeLessThan(
      ((await order()) as string[]).indexOf(b),
    );

    // Carry the LAST one above the first: a drop above a row's midpoint puts
    // the dragged project before it.
    await pointerDrag(row(b), row(a), { land: "top" });
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.indexOf(b) < o.indexOf(a);
      },
      { timeout: 8_000, timeoutMsg: "dragging a project did not reorder the sidebar" },
    );
  });

  it("drops a project into a group folder", async () => {
    const [a, b] = ids;
    // Make a folder out of one project, then drag the other into it. Dropping
    // on the folder header's BOTTOM half is what adopts (the top half means
    // "put it above the folder").
    await browser.execute(
      async (id, g) => {
        await window.__termic!.ipc.projectSetGroup([id], g);
        await window.__termic!.useApp.getState().loadAll();
      },
      a,
      GROUP,
    );
    await waitVisible(`[data-group-name="${GROUP}"]`);
    expect(await groupOf(b)).toBeNull();

    await pointerDrag(row(b), `[data-group-name="${GROUP}"]`, { land: "bottom" });
    await browser.waitUntil(async () => (await groupOf(b)) === GROUP, {
      timeout: 8_000,
      timeoutMsg: "dropping a project on the folder did not add it to the group",
    });
    await snap("sidebar-project-drag.png");
  });

  it("reorders a whole folder as one block", async () => {
    // Both temp projects now live in the folder; the fixture project is loose.
    const fixture = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").id as string,
    );
    const membersBefore = ((await order()) as string[]).filter((i) => ids.includes(i));

    // Drag the folder header above the loose project: the section moves as a
    // contiguous block, keeping its internal order.
    await pointerDrag(`[data-group-name="${GROUP}"]`, row(fixture), { land: "top" });
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.indexOf(membersBefore[membersBefore.length - 1]) < o.indexOf(fixture);
      },
      { timeout: 8_000, timeoutMsg: "dragging the folder did not move its members" },
    );
    const membersAfter = ((await order()) as string[]).filter((i) => ids.includes(i));
    expect(membersAfter).toEqual(membersBefore); // block move, not a shuffle
  });
});

// P1: the project `+` menu's Resume section. It's a SUBMENU (like "Branch
// from"), so the launcher keeps one row no matter how much history a project
// has. Cases: the top level shows a single Resume row, not the sessions; the
// submenu lists the recent archived ones and restores the picked one.
describe("resume submenu", () => {
  const archived: string[] = [];
  let projectId = "";

  after(async () => {
    // Archive whatever these cases restored, so the board is left as found.
    await browser.execute(async (ids) => {
      for (const id of ids) {
        try { await window.__termic!.ipc.taskArchive(id); } catch { /* already gone */ }
      }
      await window.__termic!.useApp.getState().loadAll();
    }, archived);
  });

  const menuText = async () =>
    (await browser.execute(() => {
      const m = document.querySelector('[role="menu"]') as HTMLElement | null;
      return m?.innerText ?? "";
    })) as string;

  const openMenu = async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    // Radix opens on pointerdown, so a bare .click() isn't enough.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
  };

  it("keeps the sessions behind one Resume row", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    projectId = (await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").id as string,
    )) as string;

    // Two archived sessions to resume. Repo-root tasks: archiving one never
    // touches a worktree.
    for (const name of ["e2e-resume-a", "e2e-resume-b"]) {
      const id = (await browser.execute(async (pid, n) => {
        const t = window.__termic!;
        const task = await t.ipc.taskOpenRepo(pid, "fakeagent", n);
        await t.ipc.taskArchive(task.id);
        await t.useApp.getState().loadAll();
        return task.id as string;
      }, projectId, name)) as string;
      archived.push(id);
    }

    await openMenu();
    const text = await menuText();
    expect(text).toContain("Resume");
    // The point of the submenu: the sessions themselves are NOT on the top
    // level, so the agents stay near the cursor however long the history is.
    expect(text).not.toContain("e2e-resume-b");
  });

  it("lists the recent sessions and restores the picked one", async () => {
    // Submenus open on hover; the trigger carries aria-haspopup.
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')].find((e) =>
        e.textContent?.includes("Resume"),
      ) as HTMLElement | undefined;
      if (!t) throw new Error("no Resume submenu trigger");
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });

    const items = async () =>
      (await browser.execute(() =>
        [...document.querySelectorAll('[role="menuitem"]')]
          .map((e) => (e as HTMLElement).innerText.trim())
          .filter(Boolean),
      )) as string[];
    await browser.waitUntil(
      async () => (await items()).some((t) => t.includes("e2e-resume-b")),
      { timeout: 8_000, timeoutMsg: "the Resume submenu never listed the sessions" },
    );
    // Most-recently archived first, and both are offered.
    const listed = await items();
    expect(listed.some((t) => t.includes("e2e-resume-a"))).toBe(true);

    // Picking one restores it and makes it the active task.
    await browser.execute(() => {
      const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
        (e as HTMLElement).innerText.includes("e2e-resume-b"),
      ) as HTMLElement | undefined;
      if (!row) throw new Error("no e2e-resume-b row");
      row.click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const s = window.__termic!.useApp.getState();
          const t = s.tasks.find((w: any) => w.id === s.activeTaskId);
          return !!t && t.name === "e2e-resume-b" && !t.archived;
        }),
      { timeout: 10_000, timeoutMsg: "picking a Resume entry did not restore the task" },
    );
    await snap("resume-submenu.png");
  });
});

// Issue #152: the dashboard's "No projects yet" card is the biggest thing a
// new user sees and reads as actionable, so it must actually be a button that
// opens the same Add project dialog as the sidebar "+" and the action card.
// The seeded profile always has fixture-repo, so the empty state is rendered
// by emptying the store's project list (disk untouched) and restored with
// loadAll() afterwards.
describe("dashboard empty state", () => {
  const CARD = '[data-testid="empty-projects-card"]';

  const showEmptyDashboard = async () => {
    await browser.execute(() => {
      window.__termic!.useApp.getState().setView("dashboard");
      window.__termic!.useApp.setState({ projects: [] });
    });
    await waitVisible(CARD);
  };
  const closeDialog = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewProject());
    await dismissOverlays();
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
  });
  after(async () => {
    await closeDialog();
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
  });

  it("opens the Add project dialog when the card is clicked", async () => {
    await showEmptyDashboard();
    await clickWhenVisible(CARD);
    await waitForText("Add project");
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some((d) =>
            (d as HTMLElement).innerText.includes("Add project"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "clicking the empty state did not open the Add project dialog" },
    );
    await snap("empty-projects-card.png");
    await closeDialog();
  });

  it("is a real button, focusable and activated by the keyboard", async () => {
    await showEmptyDashboard();
    const tag = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).tagName,
      CARD,
    );
    expect(tag).toEqual("BUTTON");

    // Reachable by Tab and focusable: a <div onClick> fails both. We assert
    // the tab order rather than pressing Enter, because native button
    // activation from a WebDriver key event doesn't land on the offscreen
    // window (the browser supplies that behaviour, we only supply the button).
    const { tabIndex, disabled, focusable } = await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLButtonElement;
      el.focus();
      return {
        tabIndex: el.tabIndex,
        disabled: el.disabled,
        focusable: document.activeElement === el,
      };
    }, CARD);
    expect(tabIndex).toBeGreaterThanOrEqual(0);
    expect(disabled).toBe(false);
    expect(focusable).toBe(true);
  });

  it("goes back to the project list once a project exists", async () => {
    await showEmptyDashboard();
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitGone(CARD);
  });
});
