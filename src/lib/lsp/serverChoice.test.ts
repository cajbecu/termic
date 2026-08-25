import { describe, expect, it, beforeEach } from "vitest";
import {
  machineCommand, preferredServer, serverChoiceFor, setChosenCommands, setChosenServers,
} from "./serverChoice";

// The Django lesson: the fix for a server answering badly was not a setting,
// it was a different process. This is the value that carries that choice down
// to resolution, and it lives outside the prefs store because the resolver is
// reached from code that must not import the store (see the module comment).

describe("the server a language is set to", () => {
  beforeEach(() => setChosenServers({}));

  it("is null until somebody picks one", () => {
    // Null means termic's own order, which is what an unset preference must
    // mean: every language still resolves to a server.
    expect(preferredServer("python")).toBeNull();
  });

  it("answers with the pick, per language", () => {
    setChosenServers({ python: "ty" });
    expect(preferredServer("python")).toBe("ty");
    // A language nobody chose for is unaffected by one that was chosen for.
    expect(preferredServer("typescript")).toBeNull();
  });

  it("follows the latest value rather than merging", () => {
    // The store writes the whole record: clearing a pick has to clear it here
    // too, or the setting says Automatic while the old server keeps starting.
    setChosenServers({ python: "ty" });
    setChosenServers({});
    expect(preferredServer("python")).toBeNull();
  });
});

describe("project over machine", () => {
  beforeEach(() => { setChosenServers({}); setChosenCommands({}); });

  const project = (servers?: Record<string, string>, commands?: Record<string, string>) =>
    ({ code_intel_servers: servers, code_intel_commands: commands });

  it("uses the machine setting for a project that said nothing", () => {
    setChosenServers({ python: "ty" });
    setChosenCommands({ python: "pylsp" });
    expect(serverChoiceFor(undefined, "python")).toEqual({ server: "ty", command: "pylsp" });
    expect(serverChoiceFor(project(), "python")).toEqual({ server: "ty", command: "pylsp" });
  });

  it("lets the project override, because it is the narrower statement", () => {
    // "This repo needs pyright" beats "on this machine I like zuban".
    setChosenServers({ python: "zuban" });
    expect(serverChoiceFor(project({ python: "basedpyright" }), "python").server)
      .toBe("basedpyright");
  });

  it("resolves the command and the pick independently", () => {
    // A project that names a command for Python must not lose this machine's
    // pick for TypeScript, and naming a pick must not clear a command.
    setChosenServers({ typescript: "typescript-language-server" });
    setChosenCommands({ python: "pylsp" });
    const p = project({ python: "ty" });
    expect(serverChoiceFor(p, "python")).toEqual({ server: "ty", command: "pylsp" });
    expect(serverChoiceFor(p, "typescript"))
      .toEqual({ server: "typescript-language-server", command: null });
  });

  it("answers null for a language nobody has an opinion about", () => {
    // Which is what makes termic's own resolution order the default.
    expect(serverChoiceFor(project({ python: "ty" }), "rust"))
      .toEqual({ server: null, command: null });
    expect(machineCommand("rust")).toBeNull();
    expect(preferredServer("rust")).toBeNull();
  });
});
