import { describe, expect, it } from "vitest";
import { reapOrphanedServers } from "./pageSession";

// Deliberately NOT mocking `@tauri-apps/api/core`, which is the whole point:
// under vitest there is no Tauri host, so `invoke` fails for real, exactly as
// it would in a browser preview or against an older binary with no
// `lsp_reap_foreign` command.
//
// This call sits in App's startup effect. It must never reject there: the
// worst case of a failed reap is the leak we already had, and taking the
// shell down over it would be trading a leak for a blank window. (A mocked
// throw cannot prove this — vitest reports an error thrown inside a `vi.fn`
// as an unhandled error even when the code under test catches it.)
describe("reaping with no host to ask", () => {
  it("resolves to zero instead of rejecting", async () => {
    await expect(reapOrphanedServers()).resolves.toBe(0);
  });
});
