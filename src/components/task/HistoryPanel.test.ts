import { describe, it, expect } from "vitest";
import { clampLane, commitAge, detailIndent, parseRefs, textIndent } from "./HistoryPanel";

// A fixed "now" so these never depend on the clock.
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08-15T12:00:00Z
const ago = (secs: number) => Math.floor(NOW / 1000) - secs;

describe("commitAge", () => {
  it("counts up through minutes, hours and days", () => {
    expect(commitAge(ago(5), NOW)).toBe("now");
    expect(commitAge(ago(59), NOW)).toBe("now");
    expect(commitAge(ago(60), NOW)).toBe("1m");
    expect(commitAge(ago(14 * 60), NOW)).toBe("14m");
    expect(commitAge(ago(60 * 60), NOW)).toBe("1h");
    expect(commitAge(ago(23 * 3600), NOW)).toBe("23h");
    expect(commitAge(ago(24 * 3600), NOW)).toBe("1d");
    expect(commitAge(ago(6 * 24 * 3600), NOW)).toBe("6d");
  });

  it("switches to a date past a week, and adds the year once it is not this one", () => {
    // A day/month label — exact wording is locale-dependent, so assert on what
    // must hold: no relative suffix, and the day number is in there.
    const lastMonth = commitAge(ago(40 * 24 * 3600), NOW);
    expect(lastMonth).not.toMatch(/\d+[mhd]$/);
    expect(lastMonth).toMatch(/\d/);
    // Two years back must name the year; same-year dates must not.
    expect(commitAge(ago(730 * 24 * 3600), NOW)).toMatch(/2024/);
    expect(commitAge(ago(40 * 24 * 3600), NOW)).not.toMatch(/20\d\d/);
  });

  it("does not blow up on a clock-skewed future commit", () => {
    // A commit stamped in the future (skewed machine, rebased date, a repo
    // written by a VM with a bad clock) reads as "now", never as a negative
    // age: the ladder's first rung is `secs < 60`, which every negative
    // number satisfies. Pinned at several magnitudes so nobody "fixes" the
    // ladder into an early `-120m` return.
    expect(commitAge(ago(-60), NOW)).toBe("now");
    expect(commitAge(ago(-7200), NOW)).toBe("now");
    expect(commitAge(ago(-365 * 24 * 3600), NOW)).toBe("now");
  });
});

describe("clampLane", () => {
  it("folds an overflowing column onto the last drawn one", () => {
    // The gutter is clipped at MAX_LANES; a commit sitting in a wider lane
    // must still get a dot, on the edge column, rather than rendering a row
    // with no node at all.
    expect(clampLane(0, 6)).toBe(0);
    expect(clampLane(5, 6)).toBe(5);
    expect(clampLane(6, 6)).toBe(5);
    expect(clampLane(41, 6)).toBe(5);
  });

  it("survives a degenerate gutter", () => {
    // graphWidth is 0 for an empty history; the clamp must not return -1 and
    // paint the dot off the left edge.
    expect(clampLane(0, 0)).toBe(0);
    expect(clampLane(3, 0)).toBe(0);
    expect(clampLane(-2, 6)).toBe(0);
  });
});

describe("parseRefs", () => {
  it("splits git's decorations into typed chips, most informative first", () => {
    // Only the first couple of chips fit on a row, so the order IS the
    // feature: HEAD, then local branches, then tags, remotes last.
    const chips = parseRefs(["origin/main", "tag: v1.2.0", "HEAD -> main", "hotfix"]);
    expect(chips).toEqual([
      { label: "main", kind: "head" },
      { label: "hotfix", kind: "branch" },
      { label: "v1.2.0", kind: "tag" },
      { label: "origin/main", kind: "remote" },
    ]);
  });

  it("handles a detached HEAD and drops empty entries", () => {
    expect(parseRefs(["HEAD"])).toEqual([{ label: "HEAD", kind: "head" }]);
    expect(parseRefs(["", "  "])).toEqual([]);
    expect(parseRefs([])).toEqual([]);
  });

  it("keeps a slashed local branch name intact", () => {
    // `feature/x` is a local branch that LOOKS remote. The chip is a shade
    // off, but the name it shows must be the whole thing.
    expect(parseRefs(["feature/git-graph-199"])[0].label).toBe("feature/git-graph-199");
  });
});

describe("textIndent", () => {
  it("steps right one lane at a time, so a branch's rows indent as a run", () => {
    const l0 = textIndent(0, 6);
    const l1 = textIndent(1, 6);
    const l2 = textIndent(2, 6);
    expect(l1 - l0).toBe(l2 - l1);
    expect(l1).toBeGreaterThan(l0);
  });

  it("clears the dot it sits beside", () => {
    // Lane centre is lane * 12 + 6; the dot's radius is 3.5. Text must start
    // past the far edge of that circle or it would overlap its own marker.
    expect(textIndent(0, 6)).toBeGreaterThan(6 + 3.5);
    expect(textIndent(3, 6)).toBeGreaterThan(3 * 12 + 6 + 3.5);
  });

  it("folds a clipped lane onto the last drawn one, exactly as the dot does", () => {
    // The gutter draws at most `lanes` columns. A row deeper than that gets
    // its dot clamped, and its text has to land in the same place or the two
    // would part company.
    expect(textIndent(9, 6)).toBe(textIndent(5, 6));
    expect(textIndent(9, 6)).toBe(textIndent(clampLane(9, 6), 6));
  });

  it("survives a degenerate graph width without going negative", () => {
    expect(textIndent(0, 0)).toBeGreaterThan(0);
    expect(textIndent(4, 1)).toBe(textIndent(0, 1));
  });
});

// ── detailIndent ──
//
// The expanded commit's file list used to be indented by the FULL gutter, so
// its depth tracked how many lanes the graph happened to have rather than
// which lane the commit sat on. On a busy repo that pushed the block far
// enough right to take the header out of the panel and put a horizontal
// scrollbar under the whole list.

describe("detailIndent", () => {
  it("follows the commit's own lane, not the lane count", () => {
    expect(detailIndent(0, 8)).toBe(detailIndent(0, 2));
    expect(detailIndent(1, 8)).toBeGreaterThan(detailIndent(0, 8));
  });

  it("lines the block up with the subject it belongs to", () => {
    expect(detailIndent(0, 6)).toBe(textIndent(0, 6));
    expect(detailIndent(1, 6)).toBe(textIndent(1, 6));
  });

  it("stops growing past two lanes, so filenames keep their width", () => {
    const cap = detailIndent(2, 9);
    expect(detailIndent(5, 9)).toBe(cap);
    expect(detailIndent(9, 9)).toBe(cap);
  });
});
