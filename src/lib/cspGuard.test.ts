import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The CSP is a marketing claim as much as a security control. termic.dev/local
// tells people "the app only ever talks to termic.dev" and shows this exact
// `connect-src` as the proof, so a silent widening here turns a published,
// checkable promise into a lie.
//
// If you are here because this test failed: that is the point. Decide whether
// the new host belongs in the app at all (docs/../CLAUDE.md: "Widen the CSP"
// is on the do-not-do-without-asking list), and if it genuinely does, update
// BOTH this expectation and the /local page + docs/privacy.md on the site.

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, "../../src-tauri/tauri.conf.json");

/** Directives whose hosts are the ones the /local page enumerates. */
const EXPECTED_CONNECT_SRC =
  "connect-src 'self' ipc: http://ipc.localhost ws: wss: https://termic.dev";

function csp(): string {
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const value = conf?.app?.security?.csp;
  if (typeof value !== "string") throw new Error("no app.security.csp in tauri.conf.json");
  return value;
}

function directive(name: string): string | undefined {
  return csp()
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe("tauri.conf.json CSP", () => {
  it("keeps connect-src limited to local IPC and termic.dev", () => {
    expect(directive("connect-src")).toBe(EXPECTED_CONNECT_SRC);
  });

  it("allows no remote script origin", () => {
    expect(directive("script-src")).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });

  it("still declares a default-src fallback", () => {
    // Without this, an unlisted directive falls back to "anything goes" in some
    // engines, which would quietly undo the guarantee the other assertions make.
    expect(directive("default-src")).toBeDefined();
  });
});
