import { describe, it, expect } from "vitest";
import { SESSION_LOSS_NOTE, dockerToggleMessage, leaveDockerMessage } from "./sandboxSwitchCopy";

describe("sandbox switch copy", () => {
  // The whole reason this module exists: a task that moves in or out of a
  // container cannot resume its conversation afterwards, and the confirm is
  // the last moment the user can be told. A new crossing path that forgets
  // the note is the regression this pins.
  it("carries the session-loss note on every Docker crossing, both directions", () => {
    const crossings = [
      dockerToggleMessage(true),
      dockerToggleMessage(false),
      leaveDockerMessage("off"),
      leaveDockerMessage("seatbelt"),
    ];
    for (const m of crossings) expect(m).toContain(SESSION_LOSS_NOTE);
  });

  it("says what actually happens: no resume, but nothing deleted either", () => {
    // Users read "history is lost" as "you deleted my transcripts". It stays
    // in whichever store wrote it; it is simply not reachable from the other
    // cage. Both halves have to survive an edit of this string.
    expect(SESSION_LOSS_NOTE).toMatch(/cannot be resumed/i);
    expect(SESSION_LOSS_NOTE).toMatch(/not deleted/i);
  });

  it("keeps each direction's own explanation of what restarts", () => {
    expect(dockerToggleMessage(true)).toContain("inside the container");
    expect(dockerToggleMessage(false)).toContain("outside the container");
    expect(leaveDockerMessage("off")).toContain("NO sandbox");
    expect(leaveDockerMessage("seatbelt")).toContain("Seatbelt");
  });

  it("uses no em dashes (project copy rule)", () => {
    for (const m of [SESSION_LOSS_NOTE, dockerToggleMessage(true), leaveDockerMessage("off")]) {
      expect(m).not.toContain("—");
    }
  });
});
