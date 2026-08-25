// Per-member last-used mode persistence for the multi-repo New Task dialog.
// localStorage is stubbed (node vitest has none), so these run everywhere.

import { beforeEach, describe, expect, it } from "vitest";
import {
  LS_MEMBER_MODES,
  persistMemberMode,
  readMemberModes,
  seedMemberMode,
} from "./memberModes";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("readMemberModes", () => {
  it("returns {} when nothing is stored", () => {
    expect(readMemberModes()).toEqual({});
  });

  it("drops unknown values and survives a corrupt blob", () => {
    store.set(LS_MEMBER_MODES, JSON.stringify({ "/a": "worktree", "/b": "yolo", "/c": 3 }));
    expect(readMemberModes()).toEqual({ "/a": "worktree" });
    store.set(LS_MEMBER_MODES, "not json {");
    expect(readMemberModes()).toEqual({});
    store.set(LS_MEMBER_MODES, JSON.stringify("a string"));
    expect(readMemberModes()).toEqual({});
  });
});

describe("persistMemberMode", () => {
  it("merges into the stored map instead of clobbering it", () => {
    persistMemberMode("/repo/a", "repo_root");
    persistMemberMode("/repo/b", "worktree");
    expect(readMemberModes()).toEqual({ "/repo/a": "repo_root", "/repo/b": "worktree" });
    persistMemberMode("/repo/a", "worktree");
    expect(readMemberModes()).toEqual({ "/repo/a": "worktree", "/repo/b": "worktree" });
  });

  it("swallows a throwing storage (dialog must not break)", () => {
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(() => persistMemberMode("/repo/a", "worktree")).not.toThrow();
    expect(readMemberModes()).toEqual({});
  });
});

describe("seedMemberMode", () => {
  it("non-git always forces repo_root, even over a remembered worktree", () => {
    expect(seedMemberMode(true, { "/a": "worktree" }, "/a")).toBe("repo_root");
  });

  it("uses the remembered mode for git members", () => {
    expect(seedMemberMode(false, { "/a": "repo_root" }, "/a")).toBe("repo_root");
    expect(seedMemberMode(false, { "/a": "worktree" }, "/a")).toBe("worktree");
  });

  it("defaults to worktree when nothing is remembered", () => {
    expect(seedMemberMode(false, {}, "/a")).toBe("worktree");
  });
});
