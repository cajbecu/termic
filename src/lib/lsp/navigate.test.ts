import { describe, expect, it, beforeEach } from "vitest";
import { pointFor, taskForPath } from "./navigate";
import { useApp } from "@/store/app";

// The two decisions the jump trail makes before any IO: which task a path
// belongs to, and whether that path is inside it. Both are how a definition in
// site-packages or a sibling worktree opens in the right place; the rest of
// this module drives CodeMirror and is covered by `codenav.e2e.ts`.

const task = (id: string, path: string) => ({ id, path, project_id: "p" }) as any;

describe("which task a path belongs to", () => {
  beforeEach(() => useApp.setState({ tasks: [], activeTaskId: null } as any));

  it("prefers the ACTIVE task when the path is inside it", () => {
    // Two tasks on one checkout is the normal case, and both match by prefix.
    // Answering with whichever came first in the list would move the reader to
    // another task's tab strip on a jump inside their own file.
    useApp.setState({
      tasks: [task("other", "/repo"), task("active", "/repo")],
      activeTaskId: "active",
    } as any);
    expect(taskForPath("/repo/src/main.ts")?.id).toBe("active");
  });

  it("finds the task that owns the path when the active one does not", () => {
    useApp.setState({
      tasks: [task("a", "/repo-a"), task("b", "/repo-b")],
      activeTaskId: "a",
    } as any);
    expect(taskForPath("/repo-b/src/main.ts")?.id).toBe("b");
  });

  it("falls back to the active task for a path outside every checkout", () => {
    // A definition in site-packages or the module cache: it belongs to no
    // task, and the answer has to be SOME task or the jump cannot open a tab
    // at all. It opens as external, which `pointFor` decides.
    useApp.setState({ tasks: [task("a", "/repo-a")], activeTaskId: "a" } as any);
    expect(taskForPath("/usr/lib/python3/site-packages/x.py")?.id).toBe("a");
  });

  it("does not match a sibling whose path is a prefix by string", () => {
    // `/repo-a-2` starts with `/repo-a`. Comparing without the separator sends
    // every jump in one worktree to the other one.
    useApp.setState({
      tasks: [task("a", "/repo-a"), task("a2", "/repo-a-2")],
      activeTaskId: "a",
    } as any);
    expect(taskForPath("/repo-a-2/src/main.ts")?.id).toBe("a2");
  });

  it("answers null when there are no tasks at all", () => {
    expect(taskForPath("/anywhere/x.ts")).toBeNull();
  });
});

describe("the point a jump records", () => {
  it("stores a path relative to the task, for a file inside it", () => {
    expect(pointFor("t1", "/repo", "/repo/src/main.ts", 12, 4)).toEqual({
      taskId: "t1", path: "src/main.ts", external: false, line: 12, col: 4,
    });
  });

  it("keeps the absolute path and marks it external, for a file outside", () => {
    // The tab type turns on this flag: an external file is opened read-only
    // from disk rather than through the task's contained read.
    const p = pointFor("t1", "/repo", "/usr/lib/python3/x.py", 3);
    expect(p.external).toBe(true);
    expect(p.path).toBe("/usr/lib/python3/x.py");
    expect(p.col).toBeUndefined();
  });

  it("treats a sibling directory as external, not as a relative path", () => {
    // `/repo-2/x.ts` against task `/repo`: slicing without checking the
    // separator would record `2/x.ts`, a path that exists nowhere.
    const p = pointFor("t1", "/repo", "/repo-2/x.ts", 1);
    expect(p.external).toBe(true);
    expect(p.path).toBe("/repo-2/x.ts");
  });
});
