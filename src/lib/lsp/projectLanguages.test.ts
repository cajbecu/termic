import { describe, it, expect } from "vitest";
import { languagesPresent, projectLanguages } from "./projectLanguages";

// Double-shift with no file open is when someone most wants to find a symbol
// and when the app has the least to go on. This is the guess that lets the
// dialog offer the right server anyway.

describe("what is this project written in", () => {
  it("takes a root manifest as a statement of intent", () => {
    // One script does not make a Python project; `pyproject.toml` does, and
    // that is the answer even when the file count disagrees.
    expect(projectLanguages(["pyproject.toml", "tools/gen.py"])).toEqual(["python"]);
  });

  it("counts files when there is no manifest at all", () => {
    // Vendored trees, monorepo subtrees and script collections have no
    // manifest on top, and are no less written in something.
    expect(projectLanguages(["a.rs", "b.rs", "c.rs", "notes.md"])).toEqual(["rust"]);
  });

  it("ignores an incidental file", () => {
    const files = ["package.json", "src/a.ts", "src/b.ts", "scripts/deploy.py"];
    expect(projectLanguages(files)).toEqual(["typescript"]);
  });

  it("names both languages of a project that really has two", () => {
    // A Django app with a TypeScript frontend is the normal case, not an edge
    // one, and both deserve an offer.
    const files = [
      "pyproject.toml", "app/models.py", "app/views.py", "app/urls.py",
      "package.json", "web/a.ts", "web/b.ts", "web/c.ts",
    ];
    expect(projectLanguages(files).sort()).toEqual(["python", "typescript"]);
  });

  it("puts the language the project is most obviously about first", () => {
    const files = [
      "Cargo.toml", "src/lib.rs", "src/main.rs", "src/parse.rs",
      "docs/build.py", "docs/serve.py", "docs/deploy.py",
    ];
    expect(projectLanguages(files)[0]).toBe("rust");
  });

  it("discounts a manifest that is not at the root", () => {
    // node_modules, fixtures and vendored packages are full of manifests that
    // say nothing about the project you opened.
    const files = ["e2e/fixtures/thing/package.json", "src/main.rs", "src/a.rs", "src/b.rs"];
    expect(projectLanguages(files)[0]).toBe("rust");
  });

  it("answers nothing for a project of prose", () => {
    expect(projectLanguages(["README.md", "docs/spec.md", "LICENSE"])).toEqual([]);
    expect(projectLanguages([])).toEqual([]);
  });
});

describe("what is worth OFFERING, which is a laxer question", () => {
  it("offers a language present in only one file", () => {
    // Deciding what to start unasked is strict, because it spends memory.
    // Deciding what to offer is not: a repo with one `.ts` file in it is
    // exactly where somebody might want to follow a symbol, and refusing
    // because there are not three of them is the feature hiding from its user.
    const files = ["pyproject.toml", "app/models.py", "app/views.py", "tools/build.ts"];
    expect(projectLanguages(files)).toEqual(["python"]);
    expect(languagesPresent(files)).toEqual(["python", "typescript"]);
  });

  it("still refuses a language the checkout has no trace of", () => {
    // The actual complaint: "Enable Rust" and "Enable Go" offered on a Django
    // repo, asking the reader to evaluate two languages that appear nowhere.
    const files = ["pyproject.toml", "app/models.py", "README.md"];
    expect(languagesPresent(files)).toEqual(["python"]);
  });

  it("puts what the project is mostly about first", () => {
    const files = ["Cargo.toml", "src/a.rs", "src/b.rs", "src/c.rs", "docs/gen.py"];
    expect(languagesPresent(files)[0]).toBe("rust");
    expect(languagesPresent(files)).toContain("python");
  });
});

describe("the languages added after the first four", () => {
  it("reads a C or C++ project from its build system and its sources", () => {
    // One server answers for the whole C family, so all of these are "cpp".
    expect(projectLanguages(["CMakeLists.txt"])).toContain("cpp");
    expect(projectLanguages(["compile_commands.json"])).toContain("cpp");
    expect(projectLanguages(["src/a.c", "src/b.h", "src/c.cpp"])).toContain("cpp");
    expect(projectLanguages(["App/View.m", "App/View.h", "App/Main.mm"])).toContain("cpp");
  });

  it("reads Swift and Ruby", () => {
    expect(projectLanguages(["Package.swift"])).toContain("swift");
    expect(projectLanguages(["Sources/a.swift", "Sources/b.swift", "Tests/c.swift"]))
      .toContain("swift");
    expect(projectLanguages(["Gemfile"])).toContain("ruby");
    expect(projectLanguages(["app/models/user.rb", "app/models/post.rb", "Rakefile.rb"]))
      .toContain("ruby");
  });

  it("does not put a language in front of anyone over one stray file", () => {
    // Same rule as the original four: a single vendored .rb in a Rust repo is
    // not a reason to offer to start a Ruby server.
    expect(projectLanguages(["Cargo.toml", "vendor/thing.rb"])).not.toContain("ruby");
    // But it is still something the checkout HAS, so it can be offered.
    expect(languagesPresent(["Cargo.toml", "vendor/thing.rb"])).toContain("ruby");
  });
});
