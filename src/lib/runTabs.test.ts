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

import { customRunMember, expandPreviewUrl, isCustomRunMember } from "@/lib/runTabs";
import type { Project, Task } from "@/lib/types";

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

describe("expandPreviewUrl", () => {
  // Minimal shapes: expandPreviewUrl only reads preview_url, port, name
  // and extra_named_ports.
  const project = (preview_url: string) => ({ preview_url }) as Project;
  const task = (extra?: Task["extra_named_ports"]) =>
    ({ port: 18100, name: "montreal", extra_named_ports: extra }) as Task;

  it("expands extra named ports alongside the built-ins", () => {
    const t = task([
      { name: "API_PORT", port: 18101 },
      // Longer name sharing a prefix: must not be clobbered by the
      // shorter one's replacement.
      { name: "API_PORT_EXT", port: 18102 },
    ]);
    expect(
      expandPreviewUrl(project("http://localhost:$API_PORT/x?e=$API_PORT_EXT&p=$TERMIC_PORT"), t),
    ).toBe("http://localhost:18101/x?e=18102&p=18100");
  });

  it("expands the braced form too", () => {
    const t = task([{ name: "API_PORT", port: 18101 }]);
    expect(expandPreviewUrl(project("http://x/${API_PORT}"), t)).toBe("http://x/18101");
  });

  it("leaves the URL untouched when no named ports are frozen", () => {
    expect(expandPreviewUrl(project("http://localhost:$TERMIC_PORT"), task()))
      .toBe("http://localhost:18100");
  });

  it("keeps built-in tokens from eating longer extras and vice versa", () => {
    // TERMIC_WORKSPACE_NAME_2 is a legal extra sharing a built-in prefix;
    // longest-first replacement must expand it as itself, and the plain
    // built-ins must still work in the same template.
    const t = task([{ name: "TERMIC_WORKSPACE_NAME_2", port: 18105 }]);
    expect(
      expandPreviewUrl(project("http://x/$TERMIC_WORKSPACE_NAME_2?p=$PORT&n=$TERMIC_WORKSPACE_NAME"), t),
    ).toBe("http://x/18105?p=18100&n=montreal");
  });
});
