import { describe, it, expect } from "vitest";
import { planAutoStart } from "./autoStart";
import type { Project, Task } from "@/lib/types";

// "Always for this project" has to mean it without an editor open. The chip
// was the only reader of that setting, and the chip only exists when a file of
// the right language is on screen, so a task opened to run a command had no
// server until somebody went looking for one.

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1", name: "repo", root_path: "/repo", tasks_path: "", base_branch: "main",
  remote: "origin", preview_url: "", setup_script: "", run_script: "", archive_script: "",
  default_cli: "claude", created: "", non_git: false,
  ...over,
} as Project);

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", project_id: "p1", name: "task", path: "/repo", branch: "main",
  is_main_checkout: true, archived: false,
  ...over,
} as Task);

/** Every checkout in these tests is Python, unless a project says otherwise. */
const python = () => ["python"];

describe("what a standing instruction covers", () => {
  it("covers nothing when the project never asked", () => {
    expect(planAutoStart([task()], [project()], python)).toEqual([]);
    expect(planAutoStart([task()], [project({ code_intel_auto: "off" })], python)).toEqual([]);
  });

  it("starts on the main checkout for `main`", () => {
    const plan = planAutoStart([task()], [project({ code_intel_auto: "main" })], python);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ root: "/repo", server: "python", taskIds: ["t1"] });
  });

  it("leaves worktrees alone for `main`, because that is what main means", () => {
    // One server per worktree multiplies by the number of agents, which is the
    // whole reason the setting has two values instead of a checkbox.
    const wt = task({ id: "t2", is_main_checkout: false, path: "/repo-wt" });
    const plan = planAutoStart([wt], [project({ code_intel_auto: "main" })], python);
    expect(plan).toEqual([]);
  });

  it("covers worktrees too for `all`", () => {
    const wt = task({ id: "t2", is_main_checkout: false, path: "/repo-wt" });
    const plan = planAutoStart([task(), wt], [project({ code_intel_auto: "all" })], python);
    expect(plan.map(p => p.root).sort()).toEqual(["/repo", "/repo-wt"]);
  });

  it("counts every task on one checkout, so the refcount matches reality", () => {
    // Two tasks sharing the main checkout share ONE server; the grant has to
    // know about both or closing the first would stop the second's server.
    const plan = planAutoStart(
      [task(), task({ id: "t2" })],
      [project({ code_intel_auto: "main" })],
      python,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].taskIds.sort()).toEqual(["t1", "t2"]);
  });

  it("drops an archived task, which is what stops the server", () => {
    const plan = planAutoStart(
      [task({ archived: true })],
      [project({ code_intel_auto: "main" })],
      python,
    );
    expect(plan).toEqual([]);
  });

  it("respects a project that excluded the language", () => {
    // Someone who turned Python off for this repo did not ask for it back via
    // a different setting.
    const plan = planAutoStart(
      [task()],
      [project({ code_intel_auto: "main", code_intel_languages: ["typescript"] })],
      python,
    );
    expect(plan).toEqual([]);
  });

  it("starts one server per language on a repo that has two", () => {
    const plan = planAutoStart(
      [task()],
      [project({ code_intel_auto: "main" })],
      () => ["python", "typescript"],
    );
    expect(plan.map(p => p.server).sort()).toEqual(["python", "typescript"]);
  });
});

describe("what a standing instruction is allowed to spend", () => {
  it("caps how many servers it starts on its own", async () => {
    // Nothing bounded this. Ten worktrees x four languages is forty servers,
    // and the app's own measured figures put that near 100 GB. Arming by hand
    // is still unlimited: that path discloses the cost per checkout.
    const { AUTO_START_CAP } = await import("./autoStart");
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, is_main_checkout: false, path: `/wt-${i}` }));
    const plan = planAutoStart(tasks, [project({ code_intel_auto: "all" })],
      () => ["python", "typescript", "rust", "go"]);
    expect(plan.length).toBe(AUTO_START_CAP);
  });

  it("prefers the checkout the most tasks share", () => {
    // Under a cap, WHICH servers you get matters. A main checkout carrying
    // three tasks is one server three people are using; a worktree is one
    // server for one task.
    const shared = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })];
    const lonely = task({ id: "d", is_main_checkout: false, path: "/wt" });
    const plan = planAutoStart([lonely, ...shared], [project({ code_intel_auto: "all" })], python);
    expect(plan[0].root).toBe("/repo");
    expect(plan[0].taskIds).toHaveLength(3);
  });
});
