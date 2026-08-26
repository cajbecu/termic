// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  issueRef, issueFetchCommand, issueTaskName, issueBranch, issueContext, buildIssuePrompt,
} from "./issuePrompt";
import { WORK_ISSUE_PROMPT } from "./builtinPrompts";
import { usePromptLibrary } from "@/store/prompts";
import type { ForgeIssue } from "./types";

const issue = (over: Partial<ForgeIssue> = {}): ForgeIssue => ({
  provider: "github",
  number: 21,
  title: "Auto-archive when PR merges",
  url: "https://github.com/simion/termic/issues/21",
  body: "I would like to be able to archive worktrees automatically.",
  author: "adamatan",
  comments: 3,
  labels: [],
  updated_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("issue naming", () => {
  it("leads the task name with the number so a truncated row stays identifiable", () => {
    expect(issueTaskName(issue())).toBe("#21 Auto-archive when PR merges");
    const long = issueTaskName(issue({ title: "x".repeat(200) }), 30);
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.startsWith("#21 ")).toBe(true);
  });

  it("falls back to the bare ref when a title is empty", () => {
    expect(issueTaskName(issue({ title: "   " }))).toBe("#21");
  });

  it("builds a branch that is traceable back to the issue", () => {
    expect(issueBranch(issue(), "simion")).toBe("simion/issue-21-auto-archive-when-pr-merges");
    // No prefix configured.
    expect(issueBranch(issue(), "")).toBe("issue-21-auto-archive-when-pr-merges");
    // A title that slugifies to nothing still yields a valid branch.
    expect(issueBranch(issue({ title: "???" }), "")).toBe("issue-21");
  });

  it("caps the slug so a long title does not become a 200-char branch", () => {
    const b = issueBranch(issue({ title: "one two three four five six seven eight nine" }), "");
    expect(b).toBe("issue-21-one-two-three-four-five-six");
  });

  it("uses # for both providers (GitLab reserves ! for merge requests)", () => {
    expect(issueRef(issue())).toBe("#21");
    expect(issueRef(issue({ provider: "gitlab" }))).toBe("#21");
  });

  it("picks the right CLI for the fetch command", () => {
    expect(issueFetchCommand(issue())).toBe("gh issue view 21 --comments");
    expect(issueFetchCommand(issue({ provider: "gitlab" }))).toBe("glab issue view 21 --comments");
  });
});

describe("issueContext", () => {
  it("carries identity, link and body, and points at the comments", () => {
    const c = issueContext(issue());
    expect(c).toContain("GitHub issue #21: Auto-archive when PR merges");
    expect(c).toContain("https://github.com/simion/termic/issues/21");
    expect(c).toContain("archive worktrees automatically");
    // The thread is NOT inlined; the agent is told to go get it.
    expect(c).toContain("3 comments");
    expect(c).toContain("gh issue view 21 --comments");
    expect(c).not.toContain("adamatan wrote");
  });

  it("still tells the agent to check when there are no comments yet", () => {
    const c = issueContext(issue({ comments: 0 }));
    expect(c).toContain("no comments yet");
    expect(c).toContain("gh issue view 21 --comments");
  });

  it("singularises one comment", () => {
    expect(issueContext(issue({ comments: 1 }))).toContain("1 comment,");
  });

  it("says so when the issue has no description at all", () => {
    const c = issueContext(issue({ body: "" }));
    expect(c).toContain("no description");
  });

  it("truncates a huge body rather than shipping a design doc", () => {
    const c = issueContext(issue({ body: "y".repeat(9000) }));
    expect(c).toContain("[body truncated");
    expect(c.length).toBeLessThan(6000);
  });

  it("lists labels when present", () => {
    expect(issueContext(issue({ labels: ["bug", "p1"] }))).toContain("Labels: bug, p1");
  });

  it("uses GitLab wording for a GitLab issue", () => {
    expect(issueContext(issue({ provider: "gitlab" }))).toContain("GitLab issue #21");
  });
});

describe("buildIssuePrompt", () => {
  beforeEach(() => {
    // The library persists to localStorage; start every case from the
    // shipped defaults so an edit in one does not leak into the next.
    try { localStorage.clear(); } catch { /* ignore */ }
    usePromptLibrary.getState().restoreBuiltins();
    usePromptLibrary.getState().resetPrompt("builtin:work-issue");
  });

  it("joins the issue context to the library's instructions", () => {
    const p = buildIssuePrompt(issue());
    expect(p).toContain("GitHub issue #21");
    expect(p).toContain("Work on the issue above.");
    expect(p).toContain("Do not close the issue");
    // Context first, instructions after.
    expect(p.indexOf("GitHub issue #21")).toBeLessThan(p.indexOf("Work on the issue above."));
  });

  it("respects an edited builtin, so the library is the real control surface", () => {
    usePromptLibrary.getState().updatePrompt("builtin:work-issue", {
      body: "Just fix it and say nothing.",
    });
    const p = buildIssuePrompt(issue());
    expect(p).toContain("Just fix it and say nothing.");
    expect(p).not.toContain("Do not close the issue");
  });

  it("falls back to the shipped text if the user deleted the builtin", () => {
    usePromptLibrary.getState().deletePrompt("builtin:work-issue");
    const p = buildIssuePrompt(issue());
    // A task seeded with context and no instructions would just be a wall
    // of text, so the default has to survive deletion.
    expect(p).toContain(WORK_ISSUE_PROMPT.split("\n")[0]);
  });
});
