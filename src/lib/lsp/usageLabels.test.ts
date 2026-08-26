import { describe, expect, it } from "vitest";
import { usageLabels } from "./usageLabels";

const ROOT = "/repo";
const at = (p: string, root: string | null = ROOT) => ({ path: p, root });

describe("usage row labels", () => {
  it("shows the bare name when nothing clashes", () => {
    expect(usageLabels([
      at("/repo/projects/api/views.py"),
      at("/repo/core/models.py"),
    ])).toEqual(["views.py", "models.py"]);
  });

  it("keeps every row of ONE file on the bare name", () => {
    // Nine usages in one file are nine rows about that file: repeating its
    // path on each of them is the noise the old rule was avoiding.
    expect(usageLabels([
      at("/repo/projects/api/views.py"),
      at("/repo/projects/api/views.py"),
    ])).toEqual(["views.py", "views.py"]);
  });

  it("pays for a path only where the name clashes", () => {
    // The Django case: a views.py per app. The models.py alongside them is
    // still unambiguous and stays bare.
    expect(usageLabels([
      at("/repo/projects/views.py"),
      at("/repo/orders/views.py"),
      at("/repo/core/models.py"),
    ])).toEqual(["projects/views.py", "orders/views.py", "models.py"]);
  });

  it("elides the middle of a long path", () => {
    expect(usageLabels([
      at("/repo/src/projects/api/v2/views.py"),
      at("/repo/orders/views.py"),
    ])).toEqual(["src/…/views.py", "orders/views.py"]);
  });

  it("falls back to the full path when two elisions would read the same", () => {
    // a/…/views.py twice would be the exact ambiguity this exists to remove,
    // so those rows pay for their full path instead.
    expect(usageLabels([
      at("/repo/a/api/v2/views.py"),
      at("/repo/a/web/v2/views.py"),
    ])).toEqual(["a/api/v2/views.py", "a/web/v2/views.py"]);
  });

  it("shows a file outside the checkout by its absolute path", () => {
    // site-packages: there is no checkout to be relative to, and the point of
    // the row is that it is NOT in your code.
    expect(usageLabels([
      at("/repo/app/views.py"),
      at("/usr/lib/python3/site-packages/django/views.py", null),
    ])).toEqual(["app/views.py", "/usr/…/views.py"]);
  });

  it("does not confuse two files whose names differ only by directory", () => {
    const labels = usageLabels([
      at("/repo/a/views.py"), at("/repo/b/views.py"), at("/repo/a/views.py"),
    ]);
    expect(labels).toEqual(["a/views.py", "b/views.py", "a/views.py"]);
  });
});
