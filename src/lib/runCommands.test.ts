import { describe, it, expect, vi } from "vitest";

// runCommands.ts pulls in the store + IPC at import time; neither matters for
// the pure label helpers under test.
vi.mock("@/lib/ipc", () => ({
  projectUpdate: vi.fn(),
  repoConfigLoad: vi.fn(),
  repoConfigSave: vi.fn(),
}));
vi.mock("@/store/app", () => ({ useApp: { getState: () => ({ projects: [] }) } }));

import { runCommandLabel, RUN_COMMAND_LABEL_MAX } from "@/lib/runCommands";

describe("runCommandLabel", () => {
  it("shows the command when no label is given", () => {
    expect(runCommandLabel({ label: "", command: "make check-all" })).toBe("make check-all");
  });

  it("prefers the label over the command", () => {
    expect(runCommandLabel({ label: "Check", command: "make check-all" })).toBe("Check");
  });

  it("clips overlong text with an ellipsis", () => {
    const command = "npm run build -- --mode production --target everything";
    const out = runCommandLabel({ label: "", command });
    expect(out.length).toBe(RUN_COMMAND_LABEL_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(command.startsWith(out.slice(0, -1))).toBe(true);
  });

  it("clips overlong labels the same way", () => {
    const label = "A very long label that nobody would ever want to read in a menu";
    expect(runCommandLabel({ label, command: "x" })).toBe(label.slice(0, RUN_COMMAND_LABEL_MAX - 1).trimEnd() + "…");
  });

  it("leaves text at the limit alone", () => {
    const command = "x".repeat(RUN_COMMAND_LABEL_MAX);
    expect(runCommandLabel({ label: "", command })).toBe(command);
  });
});
