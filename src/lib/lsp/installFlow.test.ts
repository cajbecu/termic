// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// The IPC download, stubbed: what is under test is the ORDER of the three
// steps (disclose, download, report), which is what the bug got wrong.
const lspInstall = vi.fn<(language: string) => Promise<string>>();
vi.mock("./install", () => ({ lspInstall: (l: string) => lspInstall(l) }));

import { confirmAndInstall, installMessage } from "./installFlow";
import { useUI } from "@/store/ui";

const askConfirm = vi.fn<(...args: any[]) => Promise<boolean>>();
const pushToast = vi.fn();

beforeEach(() => {
  lspInstall.mockReset().mockResolvedValue("/tmp/tsgo");
  askConfirm.mockReset().mockResolvedValue(true);
  pushToast.mockReset();
  useUI.setState({ askConfirm, pushToast } as any);
});

const req = {
  server: "typescript",
  label: "TypeScript 7 7.0.2",
  bytes: 9_000_000,
  language: "TypeScript",
};

describe("confirmAndInstall", () => {
  it("downloads before telling the caller to arm", async () => {
    // THE BUG: Search Everywhere's Install button armed the checkout and never
    // downloaded anything, so nothing could start and the editor chip went on
    // offering the same download. Arming is the caller's job and must only
    // happen on a true return.
    await expect(confirmAndInstall(req)).resolves.toBe(true);
    expect(lspInstall).toHaveBeenCalledWith("typescript");
  });

  it("does not download when the disclosure is declined", async () => {
    askConfirm.mockResolvedValue(false);
    await expect(confirmAndInstall(req)).resolves.toBe(false);
    expect(lspInstall).not.toHaveBeenCalled();
  });

  it("reports a failed download instead of claiming success", async () => {
    // A failure that returned true would arm a checkout with no server on it,
    // which is the exact state the bug produced: waiting forever for symbols.
    lspInstall.mockRejectedValue(new Error("checksum mismatch"));
    await expect(confirmAndInstall(req)).resolves.toBe(false);
    expect(pushToast).toHaveBeenCalledWith(
      expect.stringContaining("Could not install TypeScript 7 7.0.2"),
      "error",
    );
  });

  it("discloses per server, so two surfaces share one answer", async () => {
    // The key is what makes "don't ask again" mean the server rather than the
    // button that happened to be pressed.
    await confirmAndInstall(req);
    expect(askConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ key: "code-intel-install:typescript" }),
    );
  });
});

describe("the disclosure itself", () => {
  it("states the size, the checksum and that nothing touches PATH", () => {
    const msg = installMessage(req);
    expect(msg).toContain("9 MB");
    expect(msg).toContain("checksum");
    expect(msg).toContain("PATH");
  });

  it("prints no figure when the size is unknown, rather than a wrong one", () => {
    // Scoped to the DOWNLOAD sentence: the memory note in the paragraph below
    // has its own "about 300 MB", which is a different number about a
    // different thing and must not be read as the download size.
    const [download] = installMessage({ ...req, bytes: null }).split("\n\n");
    expect(download).not.toContain("MB");
    expect(download).toContain("checksum");
    expect(installMessage(req).split("\n\n")[0]).toContain("9 MB");
  });

  it("carries the memory note, which is the other half of the consent", () => {
    expect(installMessage(req)).toContain("300 MB");
  });
});
