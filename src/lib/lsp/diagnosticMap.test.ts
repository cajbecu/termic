import { describe, expect, it } from "vitest";
import { attribution, severityOf } from "./diagnosticMap";

describe("severityOf", () => {
  it("maps the four LSP levels", () => {
    expect(severityOf(1)).toBe("error");
    expect(severityOf(2)).toBe("warning");
    expect(severityOf(3)).toBe("info");
    expect(severityOf(4)).toBe("hint");
  });

  it("treats a missing or unknown severity as an error", () => {
    // Servers do omit it. Silently downgrading to a hint would hide real
    // errors behind the faintest underline the editor has.
    expect(severityOf(undefined)).toBe("error");
    expect(severityOf(0)).toBe("error");
    expect(severityOf(99)).toBe("error");
  });
});

describe("attribution", () => {
  it("prints the server and the rule the reader has to act on", () => {
    // zuban's real shape. "[assignment]" is the argument to `# type: ignore`
    // and to `disable_error_code`, so it is the actionable half.
    expect(attribution("zuban", "assignment")).toBe("zuban [assignment]");
  });

  it("keeps whichever half it has", () => {
    expect(attribution("zuban", undefined)).toBe("zuban");
    expect(attribution(undefined, "assignment")).toBe("[assignment]");
    expect(attribution(undefined, undefined)).toBeUndefined();
  });

  it("handles a numeric code", () => {
    // TypeScript's codes are numbers, and `2322` is still what you search for.
    expect(attribution("tsgo", 2322)).toBe("tsgo [2322]");
  });

  it("ignores an empty code rather than printing empty brackets", () => {
    expect(attribution("gopls", "")).toBe("gopls");
  });
});
