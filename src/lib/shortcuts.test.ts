import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS, FIXED_SHORTCUTS, GROUP_ORDER, NON_CONFLICTING_GROUPS, SHORTCUT_DEFS,
  bindingSignature, bindingToCmKey, bindingsEqual, isValidBinding,
} from "./shortcuts";

// `SHORTCUT_DEFS` is the single source of truth for every bindable key, and it
// had no test at all: the help modal, the settings editor and the global
// handler are all data-driven from it, so a duplicated chord or a stray id
// shows up as "that key stopped working" and nothing else.

describe("the shortcut table", () => {
  it("has a unique id per entry", () => {
    const ids = SHORTCUT_DEFS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a group the help modal renders", () => {
    // A group missing from GROUP_ORDER means those shortcuts exist, work, and
    // appear in no list anybody can read.
    for (const d of SHORTCUT_DEFS) {
      expect(GROUP_ORDER, d.id).toContain(d.group);
    }
  });

  it("gives every entry a binding that cannot swallow normal typing", () => {
    for (const d of SHORTCUT_DEFS) {
      expect(isValidBinding(d.defaultBinding), `${d.id}: ${bindingSignature(d.defaultBinding)}`)
        .toBe(true);
    }
  });

  it("hands each default chord to exactly one shortcut", () => {
    // Two entries on one chord is a race decided by the order of a switch
    // statement. The one deliberate pair is listed in NON_CONFLICTING_GROUPS,
    // because those two are claimed in contexts that cannot both be live.
    const allowed = new Set(NON_CONFLICTING_GROUPS.flat());
    const byChord = new Map<string, string[]>();
    for (const d of SHORTCUT_DEFS) {
      if (allowed.has(d.id)) continue;
      const sig = bindingSignature(d.defaultBinding);
      byChord.set(sig, [...(byChord.get(sig) ?? []), d.id]);
    }
    const clashes = [...byChord.entries()].filter(([, ids]) => ids.length > 1);
    expect(clashes, `chord claimed twice: ${JSON.stringify(clashes)}`).toEqual([]);
  });

  it("keeps DEFAULT_BINDINGS in step with the table", () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(SHORTCUT_DEFS.map(d => d.id).sort());
  });
});

describe("Back and Forward own the bracket keys", () => {
  const def = (id: string) => SHORTCUT_DEFS.find(d => d.id === id)!;

  it("binds Cmd+[ and Cmd+] to navigation, and to nothing else", () => {
    // They used to switch tasks as well, with two histories claiming them
    // conditionally on top: three meanings for one chord, decided by where
    // focus happened to be. This is the invariant that keeps it at one.
    // `bindingsEqual`, not a literal: every binding is normalised to carry
    // all three modifier flags, so a literal here would assert the shape of
    // the constructor rather than the chord.
    expect(bindingsEqual(def("nav-back").defaultBinding,
      { key: "[", cmd: true, shift: false, alt: false })).toBe(true);
    expect(bindingsEqual(def("nav-forward").defaultBinding,
      { key: "]", cmd: true, shift: false, alt: false })).toBe(true);
    const plainBracket = SHORTCUT_DEFS.filter(d =>
      (d.defaultBinding.key === "[" || d.defaultBinding.key === "]")
      && d.defaultBinding.cmd && !d.defaultBinding.shift && !d.defaultBinding.alt);
    expect(plainBracket.map(d => d.id).sort()).toEqual(["nav-back", "nav-forward"]);
  });

  it("leaves tasks and tabs on the chords that always meant them", () => {
    // The reason dropping task switching from Cmd+[ costs nothing: both other
    // routes still exist, and the arrow pair works inside a split too.
    expect(bindingsEqual(def("task-prev-arrow").defaultBinding,
      { key: "ArrowUp", cmd: true, alt: true, shift: false })).toBe(true);
    expect(bindingsEqual(def("task-next-arrow").defaultBinding,
      { key: "ArrowDown", cmd: true, alt: true, shift: false })).toBe(true);
    expect(bindingsEqual(def("tab-prev").defaultBinding,
      { key: "[", cmd: true, shift: true, alt: false })).toBe(true);
    expect(bindingsEqual(def("tab-next").defaultBinding,
      { key: "]", cmd: true, shift: true, alt: false })).toBe(true);
  });
});

describe("function keys", () => {
  it("are valid on their own", () => {
    // F12 types nothing, so it cannot swallow anybody's input. Requiring a
    // modifier would have made go-to-definition unbindable to the key every
    // IDE uses for it.
    expect(isValidBinding({ key: "F12", cmd: false, shift: false, alt: false })).toBe(true);
    expect(isValidBinding({ key: "F1", cmd: false, shift: false, alt: false })).toBe(true);
    expect(isValidBinding({ key: "F20", cmd: false, shift: false, alt: false })).toBe(true);
  });

  it("does not let a bare letter through with them", () => {
    // The rule this exception sits inside: `f` is a letter someone is typing.
    expect(isValidBinding({ key: "f", cmd: false, shift: false, alt: false })).toBe(false);
    expect(isValidBinding({ key: "F21", cmd: false, shift: false, alt: false })).toBe(false);
    expect(isValidBinding({ key: "F0", cmd: false, shift: false, alt: false })).toBe(false);
  });
});

describe("bindings in CodeMirror's notation", () => {
  // The code-navigation keys live in a CodeMirror keymap, which spells its
  // modifiers differently. A wrong string here is a key that silently does
  // nothing, and CodeMirror does not complain about one it cannot parse.
  it("spells each modifier the way CodeMirror expects", () => {
    expect(bindingToCmKey({ key: "F12", cmd: false, shift: false, alt: false })).toBe("F12");
    expect(bindingToCmKey({ key: "F12", cmd: false, shift: true, alt: false })).toBe("Shift-F12");
    expect(bindingToCmKey({ key: "F12", cmd: true, shift: false, alt: false })).toBe("Mod-F12");
    // Mod, then Alt, then Shift: CodeMirror requires that order.
    expect(bindingToCmKey({ key: "b", cmd: true, shift: true, alt: true }))
      .toBe("Mod-Alt-Shift-b");
  });

  it("converts every code-navigation default", () => {
    const ids = ["go-to-definition", "find-usages", "go-to-implementation",
                 "go-to-type-definition", "file-structure"] as const;
    for (const id of ids) {
      const key = bindingToCmKey(DEFAULT_BINDINGS[id]);
      expect(key, id).toMatch(/^(Mod-)?(Alt-)?(Shift-)?[A-Za-z0-9]+$/);
    }
  });
});

describe("shortcuts that cannot be rebound", () => {
  it("keeps them out of the bindable table", () => {
    // They have no Binding, and everything in SHORTCUT_DEFS is assumed to
    // have one: the bindings map, the conflict check, the recorder and the
    // localStorage migration would each need a special case.
    const ids = new Set(SHORTCUT_DEFS.map(d => d.id as string));
    for (const f of FIXED_SHORTCUTS) expect(ids.has(f.id), f.id).toBe(false);
  });

  it("gives each one keys to print and a reason it has no recorder", () => {
    // A row with no glyphs teaches nothing, and one with no reason reads as a
    // broken row next to every other row's button.
    for (const f of FIXED_SHORTCUTS) {
      expect(f.glyphs.length, f.id).toBeGreaterThan(0);
      expect(f.fixedReason, f.id).toBeTruthy();
      expect(GROUP_ORDER, f.id).toContain(f.group);
    }
  });

  it("lists double-Shift, which is the one people cannot guess", () => {
    const se = FIXED_SHORTCUTS.find(f => f.id === "search-everywhere");
    expect(se?.glyphs).toEqual(["⇧", "⇧"]);
    expect(se?.group).toBe("Code navigation");
  });
});

describe("the code-navigation group", () => {
  it("holds the editor jumps, and not the histories that also walk folders", () => {
    // Back / Forward stay in Navigation: they walk a folder listing's trail
    // as well as the symbol trail, so filing them under code navigation would
    // describe half of what they do.
    const inGroup = SHORTCUT_DEFS.filter(d => d.group === "Code navigation").map(d => d.id);
    expect(inGroup.sort()).toEqual([
      "file-structure", "find-usages", "go-to-definition",
      "go-to-implementation", "go-to-type-definition",
    ]);
    expect(SHORTCUT_DEFS.find(d => d.id === "nav-back")?.group).toBe("Navigation");
  });
});
