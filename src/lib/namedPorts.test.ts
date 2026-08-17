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
    for (const n of ["TERMIC_PORT", "PATH", "PORT", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERMIC_CLI_HELP"]) {
      expect(RESERVED_PORT_NAMES.has(n)).toBe(true);
    }
  });

  it("rejects the TERMIC_PORT_ sibling-port namespace", () => {
    expect(isValidPortName("TERMIC_PORT_API")).toBe(false);
    expect(isValidPortName("TERMIC_PORT_2")).toBe(false);
    // Other TERMIC_-prefixed names stay legal.
    expect(isValidPortName("TERMIC_EXTRA")).toBe(true);
  });
});
