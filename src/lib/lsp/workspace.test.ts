import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "./workspace";

// The URI round trip, which is where a server silently answers about the wrong
// file. Every request names its document by URI, and no two clients encode one
// the same way: a path with a space, a `#`, or a non-ASCII character is where
// they disagree.
//
// The rest of `workspace.ts` (MultiViewFile, the sync loop, the push router)
// needs real EditorViews and an LSP client, and is covered by `codenav.e2e.ts`
// against a real server over stdio.

describe("path <-> file URI", () => {
  it("round-trips an ordinary path", () => {
    expect(pathToUri("/Users/x/repo/src/main.ts")).toBe("file:///Users/x/repo/src/main.ts");
    expect(uriToPath("file:///Users/x/repo/src/main.ts")).toBe("/Users/x/repo/src/main.ts");
  });

  it("escapes what a URI cannot carry literally", () => {
    // A space and a `#` are the two that bite in practice: "My Projects" on a
    // Mac, and a `#` starts a fragment, so an unescaped one truncates the path
    // and the server answers about a file that does not exist.
    const p = "/Users/x/My Projects/a#b/main.ts";
    const uri = pathToUri(p);
    expect(uri).not.toContain(" ");
    expect(uri.slice("file://".length)).not.toContain("#");
    expect(uriToPath(uri)).toBe(p);
  });

  it("round-trips non-ASCII, byte by byte", () => {
    // Percent-encoding is defined over BYTES, not characters. Encoding the
    // code unit instead produces a URI that decodes to a different path on the
    // server's side.
    for (const p of ["/repo/café/naïve.ts", "/repo/日本語/テスト.ts", "/repo/emoji/🙂.ts"]) {
      expect(uriToPath(pathToUri(p)), p).toBe(p);
    }
  });

  it("leaves the characters a URI is allowed to keep", () => {
    // Slashes especially: escaping them would turn the path into one opaque
    // segment, which some servers reject outright.
    expect(pathToUri("/a-b/c_d/e.f~g")).toBe("file:///a-b/c_d/e.f~g");
  });

  it("refuses a URI that is not a file", () => {
    // Servers do answer with other schemes (jdt:, untitled:), and treating one
    // as a path opens an editor on nonsense.
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
    expect(uriToPath("https://example.com/a.ts")).toBeNull();
    expect(uriToPath("")).toBeNull();
  });

  it("returns null rather than throwing on a malformed escape", () => {
    // `decodeURIComponent` throws on a lone `%`, and this runs on whatever a
    // third-party server sent.
    expect(uriToPath("file:///repo/%zz.ts")).toBeNull();
  });
});
