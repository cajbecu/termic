import { describe, it, expect } from "vitest";
import { selectionFor, selectionToFields, type SandboxMode } from "@/lib/types";

describe("selectionFor", () => {
  it("reports docker regardless of the underlying mode when docker is enabled", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionFor(m, true)).toBe("docker");
    }
  });

  it("passes the seatbelt mode through unchanged when docker is disabled", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionFor(m, false)).toBe(m);
    }
  });
});

describe("selectionToFields", () => {
  it("maps docker to mode off + docker true", () => {
    expect(selectionToFields("docker")).toEqual({ mode: "off", docker: true });
  });

  it("maps every seatbelt selection to itself + docker false", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionToFields(m)).toEqual({ mode: m, docker: false });
    }
  });

  it("round-trips through selectionFor for every selection", () => {
    const selections = ["off", "monitor", "enforce-fs", "enforce", "docker"] as const;
    for (const sel of selections) {
      const { mode, docker } = selectionToFields(sel);
      expect(selectionFor(mode, docker)).toBe(sel);
    }
  });
});
