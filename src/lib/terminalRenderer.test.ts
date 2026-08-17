// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// WebGL context-loss recovery (black terminals after long idle / sleep).
// WKWebView reclaims GPU resources and every terminal's GL context dies; the
// old handler just disposed the addon and left the canvas black until the
// user restarted the tab. These tests pin the recovery contract:
//   - loss → dispose dead addon, attach a fresh one
//   - repeated losses inside the window → give up, repaint via DOM renderer
//   - silently-lost context (no event while suspended) → recovered on wake
//   - dispose() unhooks the wake listeners

const h = vi.hoisted(() => {
  class FakeWebglAddon {
    static instances: FakeWebglAddon[] = [];
    static throwOnConstruct = false;
    lossCb: (() => void) | null = null;
    disposed = false;
    contextLost = false;
    _renderer = { _gl: { isContextLost: () => this.contextLost } };
    constructor() {
      if (FakeWebglAddon.throwOnConstruct) throw new Error("no GL");
      FakeWebglAddon.instances.push(this);
    }
    onContextLoss(cb: () => void) { this.lossCb = cb; }
    onChangeTextureAtlas() {}
    dispose() { this.disposed = true; }
  }
  class FakeCanvasAddon {
    dispose() {}
  }
  return { FakeWebglAddon, FakeCanvasAddon };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: h.FakeWebglAddon }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: h.FakeCanvasAddon }));
vi.mock("@/store/prefs", () => ({
  usePrefs: { getState: () => ({ terminalRenderer: "webgl" }) },
}));
vi.mock("@/lib/terminalFontReady", () => ({
  isTerminalFontReady: () => true,
  terminalFontReady: Promise.resolve(),
}));
vi.mock("@/lib/atlasCanvasGuard", () => ({ keepAtlasCanvasConnected: () => {} }));
vi.mock("@/lib/ipc", () => ({}));

import type { Terminal } from "@xterm/xterm";
import {
  loadTerminalRenderer,
  CONTEXT_LOSS_MAX,
  CONTEXT_LOSS_WINDOW_MS,
  CONTEXT_REATTACH_DELAY_MS,
} from "./terminalRenderer";

const Fake = h.FakeWebglAddon;

function makeTerm() {
  return { loadAddon: vi.fn(), refresh: vi.fn(), rows: 24 } as unknown as Terminal & {
    loadAddon: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
}

function current() {
  return Fake.instances[Fake.instances.length - 1];
}

function loseContext() {
  const a = current();
  a.contextLost = true;
  a.lossCb?.();
}

describe("loadTerminalRenderer context-loss recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Fake.instances = [];
    Fake.throwOnConstruct = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches a WebGL addon on load", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(1);
    expect(term.loadAddon).toHaveBeenCalledWith(Fake.instances[0]);
    r.dispose();
  });

  it("re-attaches a fresh addon after context loss", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    loseContext();
    expect(first.disposed).toBe(true);
    expect(Fake.instances.length).toBe(1); // re-attach is delayed
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it("gives up after too many losses in the window and repaints via DOM renderer", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i < CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX + 1);
    loseContext(); // one over the cap
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX + 1); // no new addon
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    r.dispose();
  });

  it("keeps recovering when losses are spread beyond the window", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i < CONTEXT_LOSS_MAX * 2; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_LOSS_WINDOW_MS + 1);
    }
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX * 2 + 1);
    expect(term.refresh).not.toHaveBeenCalled();
    r.dispose();
  });

  it("does not re-attach WebGL on wake while the loss budget is spent", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i <= CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    const settled = Fake.instances.length;
    window.dispatchEvent(new Event("focus")); // user tabs back and forth
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(settled);
    r.dispose();
  });

  it("re-attaches on wake once the losses age out of the window", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i <= CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    const settled = Fake.instances.length;
    vi.advanceTimersByTime(CONTEXT_LOSS_WINDOW_MS + 1); // GPU comes back later
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(settled + 1);
    r.dispose();
  });

  it("recovers a silently-lost context on window focus", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    first.contextLost = true; // lost, but no webglcontextlost delivered
    window.dispatchEvent(new Event("focus"));
    expect(first.disposed).toBe(true);
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("retries a failed attach on wake", () => {
    Fake.throwOnConstruct = true; // GPU down at mount: attach fails, DOM stays
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(0);
    Fake.throwOnConstruct = false;
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
    r.dispose();
  });

  it("does nothing on wake while the context is healthy", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
    expect(current().disposed).toBe(false);
    r.dispose();
  });

  it("dispose() unhooks the wake guard and blocks pending re-attach", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    loseContext();
    r.dispose(); // before the re-attach timer fires
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(1);
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
  });
});
