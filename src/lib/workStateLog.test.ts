import { describe, it, expect, vi, beforeEach } from "vitest";

const append = vi.fn((_file: string, _line: string) => Promise.resolve());
vi.mock("@/lib/ipc", () => ({ ptyDebugAppend: (f: string, l: string) => append(f, l) }));

import { logWorkState, __resetWorkStateLog, WORK_STATE_LOG } from "@/lib/workStateLog";

describe("logWorkState", () => {
  beforeEach(() => { append.mockClear(); __resetWorkStateLog(); });

  it("writes one line per event to a single file", () => {
    logWorkState("set", "task=\"a\" eff=working");
    expect(append).toHaveBeenCalledTimes(1);
    const [file, line] = append.mock.calls[0] as unknown as [string, string];
    expect(file).toBe(WORK_STATE_LOG);
    expect(line).toContain("set");
    expect(line).toContain("eff=working");
    // Leading ISO timestamp, so lines from different tasks sort together.
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("caps a session so a long-running app cannot fill the disk", () => {
    for (let i = 0; i < 20_050; i++) logWorkState("set", `n=${i}`);
    expect(append.mock.calls.length).toBeLessThanOrEqual(20_000);
    // The cap ANNOUNCES itself: a tail that just stops mid-session reads as a
    // crash, which would send the next reader chasing the wrong thing.
    const lines = append.mock.calls.map(c => (c as unknown as [string, string])[1]);
    expect(lines.some(l => l.includes("log-capped"))).toBe(true);
  });

  it("never throws when the IPC bridge is missing", () => {
    append.mockImplementationOnce(() => { throw new Error("no bridge"); });
    // A diagnostic that can break the transition it observes is worse than none.
    expect(() => logWorkState("set", "x")).not.toThrow();
  });
});
