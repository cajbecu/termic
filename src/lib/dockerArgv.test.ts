import { describe, it, expect } from "vitest";
import { dockerArgvLines, formatDockerArgv } from "./dockerArgv";

// A real preview argv, trimmed to the shapes that matter.
const ARGV = [
  "docker", "run", "--rm", "-i", "-t",
  "--name", "termic-sample-preview",
  "--label", "termic.task=sample",
  "-v", "/path/to/task:/path/to/task",
  "-v", "/Users/me/Library/Application Support/termic/docker-agents/claude:/root/.claude",
  "-w", "/path/to/task",
  "-e", "TERM=xterm-256color",
  "-e", "CLAUDE_CONFIG_DIR=/root/.claude",
  "--cap-drop", "ALL",
  "--user", "501:20",
  "termic-sandbox:d9acdde7", "claude",
];

describe("dockerArgvLines", () => {
  it("keeps each mount and each variable on one line with its flag", () => {
    const lines = dockerArgvLines(ARGV);
    expect(lines).toContain("-v /path/to/task:/path/to/task");
    expect(lines).toContain("-e TERM=xterm-256color");
    expect(lines).toContain("--cap-drop ALL");
    // The bug this exists to prevent: a bare flag stranded on its own line
    // with its value on the next one.
    expect(lines).not.toContain("-v");
    expect(lines).not.toContain("-e");
  });

  it("opens with `docker run`", () => {
    expect(dockerArgvLines(ARGV)[0]).toBe("docker run");
  });

  it("gives valueless flags a line each", () => {
    const lines = dockerArgvLines(ARGV);
    expect(lines).toContain("--rm");
    expect(lines).toContain("-i");
    expect(lines).toContain("-t");
  });

  it("ends with the image and the command it runs, together", () => {
    const lines = dockerArgvLines(ARGV);
    expect(lines[lines.length - 1]).toBe("termic-sandbox:d9acdde7 claude");
  });

  it("keeps a mount path containing spaces intact", () => {
    const lines = dockerArgvLines(ARGV);
    expect(lines).toContain(
      "-v /Users/me/Library/Application Support/termic/docker-agents/claude:/root/.claude",
    );
  });

  it("keeps agent flags with the command rather than pairing them off", () => {
    // Everything after the image is the agent's own argv, flags included.
    const lines = dockerArgvLines([
      "docker", "run", "--rm", "img", "claude", "--dangerously-skip-permissions",
    ]);
    expect(lines[lines.length - 1]).toBe("img claude --dangerously-skip-permissions");
  });

  it("survives the degenerate inputs", () => {
    expect(dockerArgvLines([])).toEqual([]);
    expect(dockerArgvLines(["docker"])).toEqual(["docker"]);
    // A trailing flag with nothing after it must not read past the end.
    expect(dockerArgvLines(["docker", "run", "--rm"])).toEqual(["docker run", "--rm"]);
  });
});

describe("formatDockerArgv", () => {
  it("indents continuations under a shell line-continuation", () => {
    const out = formatDockerArgv(["docker", "run", "-e", "A=1", "img", "cmd"]);
    expect(out).toBe("docker run \\\n  -e A=1 \\\n  img cmd");
  });
});
