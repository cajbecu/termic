import { describe, it, expect } from "vitest";
import {
  PORT_BLOCK_MIN, PORT_RANGE_DEFAULT, PORT_RANGE_FLOOR,
  portRangeError, resolvePortRange, tasksThatFit,
} from "./portRange";

describe("resolvePortRange", () => {
  it("treats 0 and undefined as the default", () => {
    expect(resolvePortRange(undefined, undefined)).toEqual(PORT_RANGE_DEFAULT);
    expect(resolvePortRange(0, 0)).toEqual(PORT_RANGE_DEFAULT);
  });

  it("keeps a valid pair", () => {
    expect(resolvePortRange(3000, 4000)).toEqual({ min: 3000, max: 4000 });
  });

  it("clamps a privileged floor rather than honoring it", () => {
    expect(resolvePortRange(80, 4000)).toEqual({ min: PORT_RANGE_FLOOR, max: 4000 });
  });

  it("falls back when the pair is unusable", () => {
    expect(resolvePortRange(4000, 3000)).toEqual(PORT_RANGE_DEFAULT);
    // Narrower than one block.
    expect(resolvePortRange(3000, 3003)).toEqual(PORT_RANGE_DEFAULT);
  });

  it("resolves a half-set pair against the default for the missing half", () => {
    expect(resolvePortRange(3000, undefined)).toEqual({ min: 3000, max: PORT_RANGE_DEFAULT.max });
    // A max below the DEFAULT min is an inverted range, not a 18100-4000
    // window: it falls back, which is why the UI always saves both fields.
    expect(resolvePortRange(undefined, 4000)).toEqual(PORT_RANGE_DEFAULT);
  });

  it("agrees with portRangeError on what is acceptable", () => {
    // Anything the UI lets through must survive resolution unchanged,
    // or the user saves one range and the allocator uses another.
    for (const [min, max] of [[1024, 1030], [3000, 4000], [18100, 65535], [60000, 65535]]) {
      expect(portRangeError(min, max)).toBeNull();
      expect(resolvePortRange(min, max)).toEqual({ min, max });
    }
  });
});

describe("portRangeError", () => {
  it("accepts a sane range", () => {
    expect(portRangeError(3000, 4000)).toBeNull();
  });

  it("names the specific mistake", () => {
    expect(portRangeError(80, 4000)).toContain("1024");
    expect(portRangeError(3000, 70000)).toContain("65535");
    expect(portRangeError(4000, 3000)).toContain("above the lowest");
    expect(portRangeError(3000, 3000)).toContain("above the lowest");
    expect(portRangeError(3000, 3003)).toContain(String(PORT_BLOCK_MIN));
    expect(portRangeError(NaN, 4000)).toContain("whole numbers");
    expect(portRangeError(3000.5, 4000)).toContain("whole numbers");
  });

  it("accepts a range exactly one block wide", () => {
    expect(portRangeError(3000, 3006)).toBeNull();
  });
});

describe("tasksThatFit", () => {
  it("counts whole blocks", () => {
    expect(tasksThatFit(3000, 3005)).toBe(1);
    expect(tasksThatFit(3000, 4000)).toBe(166);
  });

  it("never goes negative on an inverted range", () => {
    expect(tasksThatFit(4000, 3000)).toBe(0);
  });
});
