import { describe, it, expect, beforeEach } from "vitest";
import { useNavHistory, type NavPoint } from "./navHistory";

// Following a definition is a one-way trip without this, and reading
// unfamiliar code is a sequence of one-way trips you need to come back from.

const at = (path: string, line: number, taskId = "t1"): NavPoint =>
  ({ taskId, path, line, external: false });

describe("jump history", () => {
  beforeEach(() => useNavHistory.getState().reset());

  it("remembers where you left from, not just where you landed", () => {
    // Back has to return you to the CALL SITE. Recording only destinations
    // would send you to the previous definition instead.
    const s = useNavHistory.getState();
    s.push(at("caller.py", 40), at("models.py", 501));
    expect(useNavHistory.getState().back()).toEqual(at("caller.py", 40));
    expect(useNavHistory.getState().forward()).toEqual(at("models.py", 501));
  });

  it("walks a chain and comes back through it in order", () => {
    const s = useNavHistory.getState();
    s.push(at("a.py", 1), at("b.py", 2));
    useNavHistory.getState().push(at("b.py", 2), at("c.py", 3));
    expect(useNavHistory.getState().back()).toEqual(at("b.py", 2));
    expect(useNavHistory.getState().back()).toEqual(at("a.py", 1));
    expect(useNavHistory.getState().back()).toBeNull();      // start of the trail
    expect(useNavHistory.getState().forward()).toEqual(at("b.py", 2));
  });

  it("drops the forward half when you jump somewhere new", () => {
    // A browser does the same: going back and then following a different link
    // is a new branch, and the abandoned one must not be reachable by Forward.
    const s = useNavHistory.getState();
    s.push(at("a.py", 1), at("b.py", 2));
    useNavHistory.getState().push(at("b.py", 2), at("c.py", 3));
    useNavHistory.getState().back();
    useNavHistory.getState().push(at("b.py", 2), at("d.py", 4));
    expect(useNavHistory.getState().canForward()).toBe(false);
    expect(useNavHistory.getState().back()).toEqual(at("b.py", 2));
  });

  it("does not record a jump that goes nowhere", () => {
    // Landing on the line you are already on is not a trip.
    const s = useNavHistory.getState();
    s.push(at("a.py", 10), at("a.py", 10));
    expect(useNavHistory.getState().canBack()).toBe(false);
  });

  it("records a SHORT jump, because a short jump is still a jump", () => {
    // The rule used to allow a few lines of slack, to stop cursor nudges
    // becoming entries — but only explicit navigations are ever recorded, so
    // it was defending against nothing and cost real jumps: going to a
    // definition three lines up recorded nothing, and Back then skipped past
    // it to wherever you had been before that.
    const s = useNavHistory.getState();
    s.push(at("a.py", 10), at("a.py", 7));
    expect(useNavHistory.getState().back()).toEqual(at("a.py", 10));
  });

  it("keeps distinct files apart even at the same line", () => {
    const s = useNavHistory.getState();
    s.push(at("a.py", 10), at("b.py", 10));
    expect(useNavHistory.getState().canBack()).toBe(true);
    expect(useNavHistory.getState().back()).toEqual(at("a.py", 10));
  });

  it("forgets a task that is gone", () => {
    // An archived task's files cannot be reopened, so a Back that lands there
    // would fail silently.
    const s = useNavHistory.getState();
    s.push(at("a.py", 1, "t1"), at("b.py", 2, "t2"));
    useNavHistory.getState().pruneTo(["t2"]);
    const { stack } = useNavHistory.getState();
    expect(stack.every(p => p.taskId === "t2")).toBe(true);
  });

  it("is bounded", () => {
    const s = useNavHistory.getState();
    for (let i = 0; i < 200; i++) s.push(null, at(`f${i}.py`, 1));
    const { stack, index } = useNavHistory.getState();
    expect(stack.length).toBeLessThanOrEqual(50);
    // The cursor still points at the newest entry after the trim.
    expect(index).toBe(stack.length - 1);
    expect(stack[stack.length - 1].path).toBe("f199.py");
  });

  it("does not write when a prune changes nothing", () => {
    // Runs from app.loadAll, which fires on a timer (bear trap 8).
    const s = useNavHistory.getState();
    s.push(at("a.py", 1), at("b.py", 2));
    const before = useNavHistory.getState().stack;
    useNavHistory.getState().pruneTo(["t1"]);
    expect(useNavHistory.getState().stack).toBe(before);
  });
});
