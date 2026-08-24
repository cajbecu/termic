import { describe, it, expect } from "vitest";
import { buildAgentBriefing, cliFallbackCommand } from "./agentBriefing";
import type { Task } from "./types";

const task = {
  id: "task-abc123",
  project_id: "proj-1",
  name: "review-auth",
  branch: "sim/review-auth",
  base_branch: "main",
  path: "/Users/x/.termic/worktrees/review-auth",
  cli: "codex",
  port: 4100,
  created: "2026-08-01T00:00:00Z",
  archived: false,
} as Task;

describe("cliFallbackCommand", () => {
  it("uses the bare command name when the link is on PATH", () => {
    expect(cliFallbackCommand({ path: "/Users/x/.local/bin/termic", name: "termic", on_path: true }))
      .toBe("termic");
  });

  it("uses the absolute path when the link is installed but off PATH", () => {
    // A bare name the login shell can't resolve would make the pasted block
    // silently fail for an agent outside Termic.
    expect(cliFallbackCommand({ path: "/usr/local/bin/termic-beta", name: "termic-beta", on_path: false }))
      .toBe("/usr/local/bin/termic-beta");
  });

  it("falls back to the build's command name when nothing is installed", () => {
    expect(cliFallbackCommand({ path: null, name: "termic-dev", on_path: false })).toBe("termic-dev");
  });

  it("survives the status call failing", () => {
    expect(cliFallbackCommand(null)).toBe("termic");
  });
});

describe("buildAgentBriefing", () => {
  const block = buildAgentBriefing({ task, projectName: "termic", cli: "termic" });

  it("names the task, project and agent up front", () => {
    expect(block.startsWith(`Termic task "review-auth" (project termic, agent codex).`)).toBe(true);
  });

  it("carries the id and worktree path, not just the name", () => {
    // The name is renameable, so the id is what a script must address.
    expect(block).toContain("TASK=task-abc123");
    expect(block).toContain("DIR=/Users/x/.termic/worktrees/review-auth");
  });

  it("prefers $TERMIC_CLI and falls back to the resolved command", () => {
    expect(block).toContain(`CLI="${"${TERMIC_CLI:-termic}"}"`);
  });

  it("threads a non-default fallback command through", () => {
    const b = buildAgentBriefing({ task, projectName: "termic", cli: "/usr/local/bin/termic-beta" });
    expect(b).toContain("${TERMIC_CLI:-/usr/local/bin/termic-beta}");
  });

  it("tells the reader not to use --wait, and why", () => {
    expect(block).toContain("Do not use --wait.");
    expect(block).toMatch(/heuristic/);
  });

  it("teaches the prompt-back protocol with a concrete reply command", () => {
    expect(block).toContain(`"$TERMIC_CLI" send <YOUR-TASK-ID> -p "review-auth: done, RESULT.md written"`);
    expect(block).toContain("$TERMIC_TASK_ID");
  });

  it("covers the no-inbox case instead of leaving --wait as the only answer", () => {
    expect(block).toContain("If you are NOT running inside a Termic task");
  });

  it("never suggests --wait as an action", () => {
    // The only mentions of --wait must be the ones telling the agent off it.
    const lines = block.split("\n").filter(l => l.includes("--wait"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/Do not use|don't wait|blocks you|rather than blocking/);
  });

  it("degrades to a readable line when the project name is unknown", () => {
    const b = buildAgentBriefing({ task, projectName: null, cli: "termic" });
    expect(b).toContain("(project unknown project, agent codex)");
  });

  it("escapes a single quote in the task name so the example stays valid shell", () => {
    const b = buildAgentBriefing({ task: { ...task, name: "sim's task" }, projectName: "termic", cli: "termic" });
    expect(b).toContain(`sim'\\''s task: done, RESULT.md written`);
  });
});

describe("buildAgentBriefing sandbox caveat", () => {
  const build = (t: Partial<Task>) =>
    buildAgentBriefing({ task: { ...task, ...t } as Task, projectName: "termic", cli: "termic" });

  it("warns that an enforcing task cannot report back at all", () => {
    // An enforcing cage denies the control-plane socket, so the prompt-back
    // protocol is unavailable to that agent; without this the reader would
    // wire up a report that never arrives.
    expect(build({ sandbox_mode: "enforce" })).toContain("ENFORCING sandbox");
    expect(build({ sandbox_mode: "enforce-fs" })).toContain("ENFORCING sandbox");
  });

  it("stays quiet for off and monitor, which do reach the CLI", () => {
    expect(build({ sandbox_mode: "off" })).not.toContain("ENFORCING sandbox");
    expect(build({ sandbox_mode: "monitor" })).not.toContain("ENFORCING sandbox");
    expect(build({})).not.toContain("ENFORCING sandbox");
  });

  it("reads the legacy sandbox_enabled flag the same way", () => {
    expect(build({ sandbox_mode: undefined, sandbox_enabled: true })).toContain("ENFORCING sandbox");
  });
});
