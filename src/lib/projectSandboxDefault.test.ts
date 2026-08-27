import { describe, it, expect } from "vitest";
import { projectSandboxDefault, mergeLists } from "./projectSandboxDefault";
import type { Project } from "@/lib/types";

const proj = (over: Partial<Project> = {}) => ({ id: "p", name: "p", ...over }) as Project;

describe("projectSandboxDefault", () => {
  it("is off for a project that has never been configured", () => {
    expect(projectSandboxDefault(proj())).toBe("off");
    expect(projectSandboxDefault(undefined)).toBe("off");
    expect(projectSandboxDefault(null)).toBe("off");
  });

  it("reads the precise mode when there is one", () => {
    expect(projectSandboxDefault(proj({ default_sandbox_mode: "monitor" }))).toBe("monitor");
    expect(projectSandboxDefault(proj({ default_sandbox_mode: "enforce-fs" }))).toBe("enforce-fs");
  });

  it("treats the legacy boolean as Enforce, which is what it always meant", () => {
    expect(projectSandboxDefault(proj({ default_sandbox: true }))).toBe("enforce");
  });

  it("prefers the precise mode over the boolean", () => {
    expect(projectSandboxDefault(proj({ default_sandbox: true, default_sandbox_mode: "monitor" })))
      .toBe("monitor");
  });

  it("lets Docker win, since the two engines are exclusive in effect", () => {
    // Both can be set on the record at once; a reader that answered "enforce"
    // here would disagree with the task that actually gets created.
    expect(projectSandboxDefault(proj({ default_docker: true }))).toBe("docker");
    expect(projectSandboxDefault(proj({ default_docker: true, default_sandbox: true }))).toBe("docker");
    expect(projectSandboxDefault(proj({ default_docker: true, default_sandbox_mode: "enforce" })))
      .toBe("docker");
  });
});

describe("mergeLists", () => {
  it("unions in order, first occurrence winning", () => {
    expect(mergeLists(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("drops blanks and handles absent sides", () => {
    expect(mergeLists(undefined, ["a", "", "a"])).toEqual(["a"]);
    expect(mergeLists()).toEqual([]);
  });
});
