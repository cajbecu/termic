import { describe, it, expect, vi, beforeEach } from "vitest";

// Two lazy chunks import this module (the editor's extension, and symbol
// search), and the bundler is free to inline it into both. When it did, the
// editor started a server and the search saw none — with a live process in
// `lsp_list` the whole time. These pin the map's identity and its refcount.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "server-id"),
  Channel: class { onmessage: ((m: string) => void) | null = null },
}));
vi.mock("dompurify", () => ({ default: { sanitize: (s: string) => s } }));
vi.mock("@codemirror/lsp-client", () => ({
  LSPClient: class {
    workspace: unknown;
    initializing = Promise.resolve(null);
    serverCapabilities = {};
    constructor(readonly config: { workspace?: (c: unknown) => unknown }) {
      this.workspace = config.workspace?.(this);
    }
    connect() { return this; }
    disconnect() {}
  },
  serverDiagnostics: () => ({}),
  LSPPlugin: { get: () => null },
  // workspace.ts extends this; a bare object is enough for the map's sake.
  Workspace: class { constructor(readonly client: unknown) {} getFile() { return null } },
}));

const ROOT = "/repo";

describe("the client map", () => {
  beforeEach(() => {
    // Whatever a previous test left behind: this map is deliberately global.
    (globalThis as Record<string, unknown>).__termicLspClients = new Map();
    // The reap uses window timers; this suite is node. Only the two the
    // module touches, so a missing one still fails loudly rather than being
    // silently swallowed.
    (globalThis as Record<string, unknown>).window = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    };
    vi.resetModules();
  });

  it("is visible to a second import of the module", async () => {
    // The real failure this reproduces: `acquireClient` returned, and
    // `clientsForRoot` in another chunk saw an empty map.
    const first = await import("./host");
    first.acquireClient(ROOT, "typescript");
    vi.resetModules();                       // simulate a second chunk copy
    const second = await import("./host");
    expect(second.clientsForRoot(ROOT).map(c => c.server)).toEqual(["typescript"]);
  });

  it("lists every server armed for one checkout, and no others", async () => {
    const host = await import("./host");
    host.acquireClient(ROOT, "typescript");
    host.acquireClient(ROOT, "python");
    host.acquireClient("/other", "rust");
    expect(host.clientsForRoot(ROOT).map(c => c.server).sort()).toEqual(["python", "typescript"]);
    expect(host.clientsForRoot("/other").map(c => c.server)).toEqual(["rust"]);
  });

  it("splits a key whose checkout path contains spaces", async () => {
    // The key is `root + " " + server`, and a path may hold spaces — so the
    // split has to come from the end, or the root comes back truncated and
    // every lookup misses.
    const host = await import("./host");
    host.acquireClient("/My Repos/thing", "python");
    expect(host.clientsForRoot("/My Repos/thing").map(c => c.server)).toEqual(["python"]);
  });

  it("hands a second caller the SAME client rather than a second server", async () => {
    const host = await import("./host");
    const a = host.acquireClient(ROOT, "typescript");
    const b = host.acquireClient(ROOT, "typescript");
    expect(a.client).toBe(b.client);
    // Releasing one must not take the client away from the other.
    a.release();
    expect(host.clientsForRoot(ROOT)).toHaveLength(1);
  });
});

describe("the status the chip reads", () => {
  it("writes phases under the key the UI looks them up by", async () => {
    // The bug this exists for: the client wrote every phase under `clientKey`
    // (NUL-joined, because it is a Map key and a checkout path can contain
    // anything) while the chip read `statusKey` (space-joined). They never
    // collide, so the busy dot, "Indexing…" and "the server stopped" were all
    // written into a slot nothing reads.
    //
    // The e2e case could not catch it: it SET the phase itself with
    // `statusKey` and asserted the chip rendered it, testing the component
    // against a store it had populated by hand. This asserts the producer.
    const { acquireClient } = await import("./host");
    const { useLspStatus, statusKey } = await import("@/store/lspStatus");
    useLspStatus.setState({ byKey: {} });

    const root = "/repo with spaces";
    const { release } = acquireClient(root, "python");
    expect(useLspStatus.getState().byKey[statusKey(root, "python")]).toBeTruthy();
    // And nothing under the client map's key, which is where it used to land.
    const stray = Object.keys(useLspStatus.getState().byKey).filter(k => k.includes("\u0000"));
    expect(stray).toEqual([]);
    release();
  });
});
