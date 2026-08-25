import { describe, it, expect, beforeEach } from "vitest";
import { useCodeIntel, checkoutRoot, grantKey, autoArms, projectServes } from "./codeIntel";
import type { Project, Task } from "@/lib/types";

const task = (over: Partial<Task>): Task => ({
  id: "t1",
  project_id: "p1",
  name: "task",
  path: "/repos/proj-wt/t1",
  branch: "feature",
  created: 0,
  ...over,
} as Task);

const project = { id: "p1", name: "proj", root_path: "/repos/proj" } as Project;

describe("code-intelligence grants (GH #174)", () => {
  beforeEach(() => useCodeIntel.setState({ grants: {} }));

  it("shares one grant between tasks on the same checkout", () => {
    // Several tasks can run in one main checkout, reading the same bytes.
    // They share the server, so the second one costs nothing and must not
    // have to ask again.
    const s = useCodeIntel.getState();
    const key = grantKey("/repos/proj", "python");
    s.arm(key, "t1");
    s.arm(key, "t2");
    expect(useCodeIntel.getState().grants[key]).toEqual(["t1", "t2"]);
    expect(useCodeIntel.getState().isArmed(key)).toBe(true);
  });

  it("keeps the grant while any task still holds it", () => {
    const s = useCodeIntel.getState();
    const key = grantKey("/repos/proj", "python");
    s.arm(key, "t1");
    s.arm(key, "t2");
    useCodeIntel.getState().release(key, "t1");
    // Turning navigation off in one task must not kill a server another task
    // is still using.
    expect(useCodeIntel.getState().isArmed(key)).toBe(true);
    useCodeIntel.getState().release(key, "t2");
    expect(useCodeIntel.getState().isArmed(key)).toBe(false);
    // And the key goes away rather than lingering as an empty array.
    expect(key in useCodeIntel.getState().grants).toBe(false);
  });

  it("drops a grant when its last task is archived", () => {
    // The point of the whole design: an enablement cannot outlive the work
    // that motivated it. The main checkout is permanent, so a sticky grant
    // there would resurrect a multi-gigabyte server months later.
    const s = useCodeIntel.getState();
    s.arm(grantKey("/repos/proj", "python"), "t1");
    s.arm(grantKey("/repos/proj-wt/t2", "python"), "t2");
    useCodeIntel.getState().pruneTo(["t2"]);
    expect(useCodeIntel.getState().isArmed(grantKey("/repos/proj", "python"))).toBe(false);
    expect(useCodeIntel.getState().isArmed(grantKey("/repos/proj-wt/t2", "python"))).toBe(true);
  });

  it("releases every checkout a task held", () => {
    const s = useCodeIntel.getState();
    s.arm(grantKey("/repos/a", "rust"), "t1");
    s.arm(grantKey("/repos/b", "rust"), "t1");
    s.arm(grantKey("/repos/b", "rust"), "t2");
    useCodeIntel.getState().releaseTask("t1");
    expect(useCodeIntel.getState().grants).toEqual({ [grantKey("/repos/b", "rust")]: ["t2"] });
  });

  it("does not write when nothing changes", () => {
    // Every set() copies the whole state and re-runs every subscriber's
    // selector (docs/performance.md bear trap 8), and these calls sit on the
    // editor-mount path.
    const s = useCodeIntel.getState();
    const key = grantKey("/repos/proj", "python");
    s.arm(key, "t1");
    const before = useCodeIntel.getState().grants;
    useCodeIntel.getState().arm(key, "t1");
    useCodeIntel.getState().release(key, "nobody");
    useCodeIntel.getState().releaseTask("nobody");
    useCodeIntel.getState().pruneTo(["t1"]);
    expect(useCodeIntel.getState().grants).toBe(before);
  });
});

describe("one repo, several languages", () => {
  beforeEach(() => useCodeIntel.setState({ grants: {} }));

  it("arms each language separately", () => {
    // A Django checkout holds Python and the JavaScript in its templates. The
    // disclosure quotes ty's memory, so agreeing to it must not also start a
    // TypeScript server: two processes, two bills, two decisions.
    const s = useCodeIntel.getState();
    s.arm(grantKey("/repos/django", "python"), "t1");
    expect(useCodeIntel.getState().isArmed(grantKey("/repos/django", "python"))).toBe(true);
    expect(useCodeIntel.getState().isArmed(grantKey("/repos/django", "typescript"))).toBe(false);
  });

  it("serves every language unless the project narrowed the list", () => {
    // Said nothing: everything termic can serve is on offer.
    expect(projectServes(undefined, "python")).toBe(true);
    expect(projectServes({}, "typescript")).toBe(true);
    // Narrowed: the excluded language shows no button at all, rather than a
    // button that does nothing.
    const proj = { code_intel_languages: ["python"] };
    expect(projectServes(proj, "python")).toBe(true);
    expect(projectServes(proj, "typescript")).toBe(false);
    // Nothing serves a language nothing serves.
    expect(projectServes(undefined, null)).toBe(false);
  });
});

describe("which checkout answers", () => {
  it("sends a main-checkout task to the project root", () => {
    // Two main-checkout tasks are the same directory, same branch, same
    // bytes: one server between them.
    expect(checkoutRoot(task({ is_main_checkout: true }), project)).toBe("/repos/proj");
  });

  it("keeps a worktree on its own path", () => {
    // Different content behind the same module paths — sharing here would
    // resolve an import into the wrong copy, which is a correctness bug.
    expect(checkoutRoot(task({}), project)).toBe("/repos/proj-wt/t1");
  });

  it("falls back to the task path when the project is gone", () => {
    expect(checkoutRoot(task({ is_main_checkout: true }), undefined)).toBe("/repos/proj-wt/t1");
  });
});

describe("per-project auto-enable", () => {
  it("arms nothing by default", () => {
    expect(autoArms("off", true)).toBe(false);
    expect(autoArms(undefined, true)).toBe(false);
  });

  it('"main" covers the main checkout only', () => {
    // Bounded: one server per language ever, however many tasks share it.
    expect(autoArms("main", true)).toBe(true);
    // A worktree task still asks — that is the unbounded side.
    expect(autoArms("main", false)).toBe(false);
  });

  it('"all" covers worktrees too', () => {
    expect(autoArms("all", true)).toBe(true);
    expect(autoArms("all", false)).toBe(true);
  });
});
