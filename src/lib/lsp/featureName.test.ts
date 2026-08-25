import { describe, expect, it } from "vitest";
import { codeIntelName, codeIntelNameLower, currentCodeIntelName } from "./featureName";
import { setDiagnosticsEnabled } from "./diagnosticsPref";

describe("what the feature is called", () => {
  it("is navigation until type checking is on", () => {
    // The default. Everything it does is navigation, and a name promising a
    // checker sends people looking for a switch they have not flipped.
    expect(codeIntelName(false)).toBe("Code navigation");
    expect(codeIntelNameLower(false)).toBe("code navigation");
  });

  it("becomes intelligence once the checker is running", () => {
    expect(codeIntelName(true)).toBe("Code intelligence");
    expect(codeIntelNameLower(true)).toBe("code intelligence");
  });

  it("tracks the switch for callers outside React", () => {
    // The CodeMirror extensions cannot read the prefs store (importing it
    // touches the DOM at module load), so they read the mirrored value.
    setDiagnosticsEnabled(false);
    expect(currentCodeIntelName()).toBe("Code navigation");
    setDiagnosticsEnabled(true);
    expect(currentCodeIntelName()).toBe("Code intelligence");
    setDiagnosticsEnabled(false);
  });
});
