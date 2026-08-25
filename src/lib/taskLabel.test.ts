// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { taskLabel, taskLabelIsBranch } from "./taskLabel";
import { usePrefs } from "@/store/prefs";

const worktree  = { name: "fix the login bug", branch: "feature/login-bug" };
const untouched = { name: "feature/login-bug", branch: "feature/login-bug" };
const repoRoot  = { name: "run in repo", branch: "main", is_main_checkout: true };
const noBranch  = { name: "notes" };

describe("taskLabel", () => {
  it("keeps the typed name while the pref is off", () => {
    expect(taskLabel(worktree, false)).toBe("fix the login bug");
    expect(taskLabelIsBranch(worktree, false)).toBe(false);
  });

  it("swaps in the branch once the pref is on", () => {
    expect(taskLabel(worktree, true)).toBe("feature/login-bug");
    expect(taskLabelIsBranch(worktree, true)).toBe(true);
  });

  it("falls back to the name on a detached HEAD", () => {
    // task_open_repo records the literal "HEAD" for a detached main checkout,
    // and a row reading "HEAD" names nothing.
    expect(taskLabel({ name: "spike", branch: "HEAD" }, true)).toBe("spike");
    expect(taskLabelIsBranch({ name: "spike", branch: "HEAD" }, true)).toBe(false);
  });

  it("falls back to the name for a task with no branch", () => {
    // "Before the branch exists, nothing changes" (GH #260): a plain-folder
    // task stores "" and must never render as an empty row.
    expect(taskLabel(noBranch, true)).toBe("notes");
    expect(taskLabel({ name: "notes", branch: "" }, true)).toBe("notes");
  });

  it("leaves a main checkout alone even though it has one", () => {
    // "Run in repo" tasks carry the shared checkout's HEAD, which is "main" in
    // every project and moves under the task on any `git checkout`. Relabelling
    // them would turn every project's repo-root row into the same word.
    expect(taskLabel(repoRoot, true)).toBe("run in repo");
    expect(taskLabelIsBranch(repoRoot, true)).toBe(false);
  });

  it("reports no swap when the name already IS the branch", () => {
    // The breadcrumb and the sidebar both collapse "<branch> on <branch>" off
    // this, so it has to stay false rather than "technically the branch".
    expect(taskLabel(untouched, true)).toBe("feature/login-bug");
    expect(taskLabelIsBranch(untouched, true)).toBe(false);
  });
});

describe("the useBranchAsTaskName pref", () => {
  beforeEach(() => {
    localStorage.clear();
    usePrefs.setState({ useBranchAsTaskName: false });
  });

  it("is off by default", () => {
    expect(usePrefs.getState().useBranchAsTaskName).toBe(false);
  });

  it("persists so it survives a relaunch", () => {
    usePrefs.getState().setUseBranchAsTaskName(true);
    expect(usePrefs.getState().useBranchAsTaskName).toBe(true);
    expect(localStorage.getItem("useBranchAsTaskName")).toBe("1");
    usePrefs.getState().setUseBranchAsTaskName(false);
    expect(localStorage.getItem("useBranchAsTaskName")).toBe("0");
  });
});
