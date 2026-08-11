import { describe, it, expect, vi } from "vitest";

// runTabs.ts pulls in the stores + IPC at import time; the member helpers under
// test are pure.
vi.mock("@/lib/ipc", () => ({
  repoConfigLoad: vi.fn(),
  repoConfigLoadAt: vi.fn(),
  repoConfigSave: vi.fn(),
  projectUpdate: vi.fn(),
}));
vi.mock("@/store/app", () => ({ useApp: { getState: () => ({ projects: [], tabs: {} }) } }));
vi.mock("@/store/ui", () => ({ useUI: { getState: () => ({}) } }));

import { customRunMember, isCustomRunMember } from "@/lib/runTabs";

describe("customRunMember", () => {
  it("keys a labeled command off its label", () => {
    expect(customRunMember({ label: "Check", command: "make check-all" })).toBe("label:Check");
  });

  it("keys an unlabeled command off its command", () => {
    expect(customRunMember({ label: "", command: "make check-all" })).toBe("cmd:make check-all");
    expect(customRunMember({ label: "  ", command: "make check-all" })).toBe("cmd:make check-all");
  });

  it("never lets a label collide with another command's raw text", () => {
    const labeled = { label: "make check-all", command: "echo something-else" };
    const unlabeled = { label: "", command: "make check-all" };
    expect(customRunMember(labeled)).not.toBe(customRunMember(unlabeled));
  });

  it("keeps long commands intact so two commands never share a run tab", () => {
    const a = { label: "", command: "npm run build -- --mode production --target one" };
    const b = { label: "", command: "npm run build -- --mode production --target two" };
    expect(customRunMember(a)).not.toBe(customRunMember(b));
  });
});

describe("isCustomRunMember", () => {
  it("claims both custom prefixes", () => {
    expect(isCustomRunMember(customRunMember({ label: "Check", command: "x" }))).toBe(true);
    expect(isCustomRunMember(customRunMember({ label: "", command: "make check-all" }))).toBe(true);
  });

  // The primary Run/Stop button drives everything this rejects, so a custom
  // member leaking through here would hand the main button someone's ad-hoc run.
  it("leaves the primary host and composition members alone", () => {
    expect(isCustomRunMember("")).toBe(false);
    expect(isCustomRunMember("api")).toBe(false);
    expect(isCustomRunMember(undefined)).toBe(false);
    expect(isCustomRunMember(null)).toBe(false);
  });
});
