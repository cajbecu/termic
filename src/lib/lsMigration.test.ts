import { describe, expect, it, beforeEach, vi } from "vitest";

// The migration runs as a SIDE EFFECT at import, so each case seeds
// localStorage and then re-imports the module.
//
// Untested until now, which is how a rebind gets lost quietly: nothing here
// throws when it goes wrong, the user simply finds their key does nothing and
// has no way to connect that to an id rename three versions ago.

const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
vi.stubGlobal("localStorage", localStorageMock);

/** Seed, run the migration, and read back. */
async function migrate(seed: Record<string, string>) {
  store.clear();
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  vi.resetModules();
  await import("./lsMigration");
  return Object.fromEntries(store.entries());
}

const KEY = "shortcutBindings";
const bind = (o: Record<string, unknown>) => JSON.stringify(o);

describe("renamed preference keys", () => {
  beforeEach(() => store.clear());

  it("carries the value across and drops the old key", async () => {
    const after = await migrate({ workspaceExpandMode: "single", collapsedWorkspaces: "[\"a\"]" });
    expect(after.taskExpandMode).toBe("single");
    expect(after.collapsedTasks).toBe("[\"a\"]");
    expect(after.workspaceExpandMode).toBeUndefined();
  });

  it("never overwrites a value already written under the new key", async () => {
    // The half-migrated case: a newer build already wrote the new key, and the
    // stale old one must not undo the user's more recent choice.
    const after = await migrate({ workspaceExpandMode: "single", taskExpandMode: "multi" });
    expect(after.taskExpandMode).toBe("multi");
    expect(after.workspaceExpandMode).toBeUndefined();
  });

  it("is idempotent", async () => {
    await migrate({ newWorkspaceLastMode: "yolo" });
    vi.resetModules();
    await import("./lsMigration");
    expect(store.get("newTaskLastMode")).toBe("yolo");
    expect(store.has("newWorkspaceLastMode")).toBe(false);
  });
});

describe("renamed shortcut ids", () => {
  beforeEach(() => store.clear());

  it("moves a rebind of the CURRENT old id to Back / Forward", async () => {
    // ⌘[ / ⌘] stopped switching tasks and became Back / Forward. Someone who
    // had bound them to something else keeps the key they chose.
    const after = await migrate({
      [KEY]: bind({ "task-prev": { key: "j", cmd: true }, "task-next": { key: "k", cmd: true } }),
    });
    const parsed = JSON.parse(after[KEY]);
    expect(parsed["nav-back"]).toEqual({ key: "j", cmd: true });
    expect(parsed["nav-forward"]).toEqual({ key: "k", cmd: true });
    expect(parsed["task-prev"]).toBeUndefined();
    expect(parsed["task-next"]).toBeUndefined();
  });

  it("carries a rebind made before BOTH renames", async () => {
    // The id was `workspace-prev`, then `task-prev`, now `nav-back`. A profile
    // old enough to predate the first rename still lands on the current id.
    const after = await migrate({ [KEY]: bind({ "workspace-prev": { key: "b", alt: true } }) });
    const parsed = JSON.parse(after[KEY]);
    expect(parsed["nav-back"]).toEqual({ key: "b", alt: true });
    expect(parsed["workspace-prev"]).toBeUndefined();
    expect(parsed["task-prev"]).toBeUndefined();
  });

  it("renames straight to a CURRENT id, never to another renamed one", async () => {
    // The invariant behind the case above, and the reason it is worth stating
    // separately: two hops (`workspace-prev` -> `task-prev` -> `nav-back`)
    // also arrive, but only because the loop happens to visit them in that
    // order. Reorder those two lines and the rebind is stranded on an id
    // nothing reads, silently. Pointing every entry at a name that exists
    // today removes the ordering from the picture.
    const { SHORTCUT_ID_RENAMES } = await import("./lsMigration");
    const renamedAway = new Set(SHORTCUT_ID_RENAMES.map(([from]) => from));
    for (const [from, to] of SHORTCUT_ID_RENAMES) {
      expect(renamedAway.has(to), `${from} -> ${to} points at a renamed id`).toBe(false);
    }
  });

  it("keeps a binding already written under the new id", async () => {
    const after = await migrate({
      [KEY]: bind({ "task-prev": { key: "j" }, "nav-back": { key: "h" } }),
    });
    const parsed = JSON.parse(after[KEY]);
    expect(parsed["nav-back"]).toEqual({ key: "h" });
    expect(parsed["task-prev"]).toBeUndefined();
  });

  it("leaves the other renames alone", async () => {
    // The arrow-key task switchers are a different pair and kept their
    // meaning; only the bracket pair changed what it does.
    const after = await migrate({
      [KEY]: bind({ "workspace-prev-arrow": { key: "ArrowUp", cmd: true, alt: true } }),
    });
    const parsed = JSON.parse(after[KEY]);
    expect(parsed["task-prev-arrow"]).toEqual({ key: "ArrowUp", cmd: true, alt: true });
  });

  it("survives an unparseable blob rather than taking boot down", async () => {
    // This module is the FIRST import in main.tsx. A throw here is a blank
    // window, so corrupt storage has to degrade to defaults.
    const after = await migrate({ [KEY]: "{not json", workspaceExpandMode: "single" });
    expect(after[KEY]).toBe("{not json");
    // It threw before reaching the shortcut blob, so the key rename above it
    // still happened.
    expect(after.taskExpandMode).toBe("single");
  });

  it("does nothing to a fresh install", async () => {
    const after = await migrate({});
    expect(Object.keys(after)).toHaveLength(0);
  });
});
