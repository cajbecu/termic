import { describe, it, expect } from "vitest";
import { isValidPortName, RESERVED_PORT_NAMES } from "./namedPorts";

describe("isValidPortName", () => {
  it("accepts plain env-var names", () => {
    expect(isValidPortName("API_PORT")).toBe(true);
    expect(isValidPortName("_db")).toBe(true);
    expect(isValidPortName("frontendPort2")).toBe(true);
  });

  it("rejects malformed names", () => {
    expect(isValidPortName("")).toBe(false);
    expect(isValidPortName("2PORT")).toBe(false);
    expect(isValidPortName("MY-PORT")).toBe(false);
    expect(isValidPortName("A B")).toBe(false);
  });

  it("rejects every reserved name", () => {
    for (const n of RESERVED_PORT_NAMES) {
      expect(isValidPortName(n)).toBe(false);
    }
    expect(RESERVED_PORT_NAMES.has("TERMIC_PORT")).toBe(true);
    expect(RESERVED_PORT_NAMES.has("PATH")).toBe(true);
  });
});
