import { describe, expect, it, vi, beforeEach } from "vitest";
import { LSP_PAGE_ID, reapOrphanedServers } from "./pageSession";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

describe("the page stamp", () => {
  beforeEach(() => invoke.mockReset());

  it("is different for every page load", async () => {
    // The whole mechanism rests on this. A stamp that survived a reload
    // (sessionStorage, a constant, a hash of the app version) would mark the
    // orphans as belonging to the page that has to kill them.
    vi.resetModules();
    const again = await import("./pageSession");
    expect(LSP_PAGE_ID).toBeTruthy();
    expect(again.LSP_PAGE_ID).not.toBe(LSP_PAGE_ID);
  });

  it("asks the host to kill everything stamped otherwise", async () => {
    invoke.mockResolvedValue(3);
    await expect(reapOrphanedServers()).resolves.toBe(3);
    expect(invoke).toHaveBeenCalledWith("lsp_reap_foreign", { page: LSP_PAGE_ID });
  });
});
