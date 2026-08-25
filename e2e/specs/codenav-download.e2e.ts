import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  archiveTask, ensureActiveTask, openTask, requireTermicApi, waitForAppShell, waitVisible,
} from "../helpers";

// The pinned-download path (GH #174), driven through the app's own commands
// against the real internet.
//
// **Opt-in**: it fetches ~35 MB from GitHub, so it is skipped unless
// `E2E_LSP_DOWNLOADS=1` is set. `make e2e` and CI do not run it; a maintainer
// runs it after touching the manifest, or to check that upstream has not moved
// out from under it.
//
//   E2E_LSP_DOWNLOADS=1 npm run test:e2e -- --spec e2e/specs/codenav-download.e2e.ts
//
// What it proves that a unit test cannot: the release API still names the
// asset the manifest expects, the bytes still match the digest that release
// advertises, the archive still holds the executable where the manifest says,
// the binary runs on this machine (no quarantine prompt, no missing sibling
// files) and the server it becomes answers about real code.

const ENABLED = process.env.E2E_LSP_DOWNLOADS === "1";

const install = async (language: string) =>
  await browser.execute(async (lang) => {
    try {
      return { ok: true, value: String(await window.__termic!.invoke("lsp_install", { language: lang })) };
    } catch (e) {
      return { ok: false, value: String(e) };
    }
  }, language) as { ok: boolean; value: string };

const offer = async (root: string, language: string) =>
  await browser.execute(
    async (r, lang) => await window.__termic!.invoke("lsp_offer", { root: r, language: lang }),
    root, language,
  ) as { exe: string | null; installLabel: string | null; installBytes: number | null };

const taskPath = (taskId: string) =>
  browser.execute(
    (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path as string,
    taskId,
  ) as Promise<string>;

const openFile = (taskId: string, rel: string) =>
  browser.execute((id, p) => {
    window.__termic!.useApp.getState().openPreviewTab(id, { type: "edit", path: p, title: p });
  }, taskId, rel);


/** Arm one checkout for one server, through the key EditorPane reads. */
const armGrant = (root: string, taskId: string, server: string) =>
  browser.execute((r, id, sv) => {
    const { useCodeIntel, grantKey } = (window as any).__termic.codeIntel;
    useCodeIntel.getState().arm(grantKey(r, sv), id);
  }, root, taskId, server);

describe("code intelligence: server downloads", function () {
  // Two of these are 14 MB over the network, then unpacked.
  this.timeout(300_000);

  let taskId = "";
  let root = "";

  before(async function () {
    if (!ENABLED) this.skip();
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setCodeIntelligence(true);
      // The point of this file is real diagnostics from a real server, and
      // type checking ships OFF. Without this the two squiggle cases wait
      // two minutes for something the pref is suppressing.
      window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(true);
    });
    taskId = await openTask("lsp-download");
    root = await taskPath(taskId);
    await ensureActiveTask(taskId);
  });

  after(async () => {
    if (!ENABLED) return;
    // Same guard as codenav.e2e.ts: `after()` runs even when `before()` threw,
    // and an empty `root` turns every sweep below into a path relative to the
    // wdio process cwd, which is this repo.
    if (!root) return;
    // The fixture repo is shared with every other spec file, and a dirty tree
    // fails git.e2e's "clean working tree" plus two layout specs.
    for (const rel of ["broken.ts"]) rmSync(path.join(root, rel), { force: true });
    rmSync(path.join(root, "pysrc"), { recursive: true, force: true });
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    await browser.execute(async () => {
      const servers: any[] = await window.__termic!.invoke("lsp_list");
      for (const s of servers) await window.__termic!.invoke("lsp_stop", { id: s.id });
    });
    // Back to the app's DEFAULT, which is on. Restoring `false` persisted a
    // non-default into the shared profile's localStorage, so every later spec
    // file and every later run started with the chip suppressed.
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setCodeIntelligence(true);
      window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(false);
    });
    if (taskId) await archiveTask(taskId);
  });

  for (const language of ["typescript", "python", "rust"]) {
    it(`downloads and verifies the ${language} server`, async () => {
      const res = await install(language);
      // The error carries the reason: a renamed asset, an unreachable API, or
      // bytes that do not match the digest the release advertises. All three
      // are things to fix, so the message has to reach whoever ran this.
      if (!res.ok) throw new Error(`install ${language} failed: ${res.value}`);
      expect(existsSync(res.value)).toBe(true);
      // Installed under termic's own directory, never on the user's PATH.
      expect(res.value).toContain("/servers/");
      expect(res.value).toContain(language);

      // Idempotent: a second call is free rather than a second download.
      const again = await install(language);
      expect(again.value).toBe(res.value);
    });
  }

  it("resolves the downloaded server for a checkout with no toolchain", async () => {
    const o = await offer(root, "typescript");
    // Nothing about TypeScript is installed in the e2e fixture repo, so the
    // one termic downloaded is what a task would drive.
    expect(o.exe).toBeTruthy();
    expect(o.exe).toContain("/servers/typescript/");
  });

  it("reports what is installed and what upstream has", async () => {
    const row = await browser.execute(async () =>
      await window.__termic!.invoke("lsp_check_update", { language: "typescript" }),
    ) as { installed: string | null; latest: string | null; upgradable: boolean; label: string };
    expect(row.label).toContain("TypeScript");
    // Installed by the case above, and the release API answered, so both
    // halves are known and the app can say which.
    expect(row.installed).toBeTruthy();
    expect(row.latest).toBeTruthy();
    // We just installed the latest, so there is nothing to offer.
    expect(row.upgradable).toBe(false);
    expect(row.installed).toBe(row.latest);
  });

  it("drives the downloaded TypeScript server against a real error", async () => {
    // A deliberate type error, so the end of the pipe is observable: real
    // server, real diagnostics, real squiggle.
    writeFileSync(path.join(root, "broken.ts"), 'export const n: number = "not a number";\n');
    await openFile(taskId, "broken.ts");
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    // `grantKey(root, server)`, not the bare root. EditorPane reads
    // `grants[grantKey(navRoot, navServer)]`, so arming the bare path put the
    // grant in a slot nothing reads: no client was ever acquired and the
    // 120s wait below could only ever time out. Nobody noticed because this
    // file is E2E_LSP_DOWNLOADS-gated and skipped by `make e2e`.
    await armGrant(root, taskId, "typescript");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 120_000);
    const server = (await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[]).find(s => s.language === "typescript");
    expect(server).toBeTruthy();
    expect(server.root).toBe(root);
  });

  it("drives the downloaded Python server against a real error", async () => {
    rmSync(path.join(root, "broken.ts"), { force: true });
    mkdirSync(path.join(root, "pysrc"), { recursive: true });
    writeFileSync(path.join(root, "pysrc", "broken.py"), "def f(x: int) -> int:\n    return \"nope\"\n");
    await openFile(taskId, "pysrc/broken.py");
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    // Python is its own grant: agreeing to TypeScript above says nothing about
    // starting a second process for a second language.
    await armGrant(root, taskId, "python");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 120_000);
    const server = (await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[]).find(s => s.language === "python");
    expect(server).toBeTruthy();
  });
});
