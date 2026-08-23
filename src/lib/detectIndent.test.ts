import { describe, it, expect } from "vitest";
import { detectIndent } from "./detectIndent";

// The editor hard-coded two spaces for every file, which is wrong for most of
// what an agent writes: Python is 4, Go is tabs, and a Makefile's tabs are
// load-bearing. These pin the cases that actually appear, including the ones
// where guessing wrong is worse than not guessing.

describe("indentation, read from the file", () => {
  it("reads four spaces off Python", () => {
    const py = [
      "def sync(instance_id: int) -> None:",
      "    store_page, _ = StorePage.objects.get_or_create(store=instance_id)",
      "    if store_page:",
      "        print(store_page)",
      "    return None",
    ].join("\n");
    expect(detectIndent(py)).toEqual({ useTabs: false, size: 4, unit: "    " });
  });

  it("reads two spaces off TypeScript", () => {
    const ts = [
      "export function helper(x: number) {",
      "  if (x > 0) {",
      "    return x * 2;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(detectIndent(ts).size).toBe(2);
  });

  it("reads tabs off Go, and a Makefile, where they are the format", () => {
    const go = "func main() {\n\tv := helper(21)\n\tif v > 0 {\n\t\tfmt.Println(v)\n\t}\n}\n";
    expect(detectIndent(go).useTabs).toBe(true);
    expect(detectIndent(go).unit).toBe("\t");
    const make = "build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n";
    expect(detectIndent(make).useTabs).toBe(true);
  });

  it("is not fooled by aligned continuation lines", () => {
    // The file steps by 2; the wrapped call is aligned at 22 columns. Taking
    // the smallest indent seen, or the most common indent, both get this
    // wrong — the STEP between consecutive lines is what carries the answer.
    const src = [
      "function f() {",
      "  const result = call(argument,",
      "                      second,",
      "                      third);",
      "  if (result) {",
      "    return result;",
      "  }",
      "}",
    ].join("\n");
    expect(detectIndent(src).size).toBe(2);
  });

  it("breaks a tie towards the smaller size", () => {
    // A file that steps by 4 also steps by 8 wherever it nests twice, so 8
    // would win ties it has not earned.
    const src = [
      "def a():",
      "    if x:",
      "        if y:",
      "            pass",
      "    return 1",
      "def b():",
      "    return 2",
    ].join("\n");
    expect(detectIndent(src).size).toBe(4);
  });

  it("falls back rather than guessing from nothing", () => {
    // No evidence at all, and a single observation is not evidence either: a
    // width the rest of the file will fight is worse than the default.
    expect(detectIndent("")).toEqual({ useTabs: false, size: 2, unit: "  " });
    expect(detectIndent("one line\nanother line\n").size).toBe(2);
    expect(detectIndent("a\n    b\n").size).toBe(2);
    // And the caller's fallback is what it falls back TO.
    expect(detectIndent("plain\n", { useTabs: false, size: 4, unit: "    " }).size).toBe(4);
  });

  it("ignores blank lines and files that are all top level", () => {
    const src = "import os\n\nimport sys\n\n\nprint(os, sys)\n";
    expect(detectIndent(src)).toEqual({ useTabs: false, size: 2, unit: "  " });
  });

  it("only reads the top of a very large file", () => {
    // Off the critical path of opening something big: the answer does not
    // improve after a few hundred lines, and reading the whole buffer would
    // cost on exactly the files where opening is already slowest.
    // Realistic: many defs, so the 0 → 4 step repeats. A single step is
    // deliberately not enough evidence (see the fallback case above).
    const huge = "def f():\n    pass\n".repeat(50_000);
    const t0 = performance.now();
    expect(detectIndent(huge).size).toBe(4);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
