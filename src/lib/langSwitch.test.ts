import { describe, expect, it } from "vitest";
import { createLangSwitch } from "./langSwitch";
import { langForId } from "./languageExts";

describe("createLangSwitch", () => {
  it("keeps a lone claim current", () => {
    const s = createLangSwitch();
    const a = s.claim();
    expect(a()).toBe(true);
    expect(a()).toBe(true); // idempotent — it is checked after every await
  });

  it("stales every earlier claim", () => {
    const s = createLangSwitch();
    const a = s.claim();
    const b = s.claim();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    const c = s.claim();
    expect(b()).toBe(false);
    expect(c()).toBe(true);
  });

  it("does not resurrect a stale claim when the newer one finishes", () => {
    const s = createLangSwitch();
    const a = s.claim();
    s.claim();
    expect(a()).toBe(false);
  });

  it("is per-switch, so two editors do not cancel each other", () => {
    const one = createLangSwitch(), two = createLangSwitch();
    const a = one.claim();
    two.claim();
    expect(a()).toBe(true);
  });
});

describe("the race it exists for", () => {
  it("drops a slow load that a later pick superseded", async () => {
    // The real shape: a file opens on a grammar whose chunk is slow, and the
    // user hits "Set syntax" before it lands. The pick starts second and must
    // win, even though the mount's load resolves last.
    const s = createLangSwitch();
    const applied: string[] = [];

    const load = async (id: string, delayMs: number) => {
      const isCurrent = s.claim();
      const ext = await langForId(id);
      await new Promise(r => setTimeout(r, delayMs));
      if (!isCurrent()) return;
      applied.push(ext ? id : "Plain Text");
    };

    const slowMount = load("Rust", 30);
    await new Promise(r => setTimeout(r, 1));
    const fastPick = load("JSON", 0);

    await Promise.all([slowMount, fastPick]);
    expect(applied).toEqual(["JSON"]);
  });
});
