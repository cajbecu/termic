// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { useUI } from "@/store/ui";

// One confirm slot serves the whole window, so a prompt nobody can answer is
// not a small mess: it blocks every other dialog until it is resolved. These
// cover the withdrawal path an asker uses when it goes away first (a terminal
// pane whose tab was closed, a task that got archived mid-prompt).
describe("confirm modal", () => {
  beforeEach(() => {
    useUI.setState({ confirm: null });
  });

  const settle = () => new Promise(r => setTimeout(r, 0));

  it("opens on the next macrotask and resolves with the answer", async () => {
    const p = useUI.getState().askConfirm({ title: "T", message: "M" });
    expect(useUI.getState().confirm).toBeNull(); // deferred, see askConfirm
    await settle();
    expect(useUI.getState().confirm?.req.title).toBe("T");

    useUI.getState().resolveConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(useUI.getState().confirm).toBeNull();
  });

  it("withdraws a prompt that is already on screen", async () => {
    const p = useUI.getState().askConfirm({ key: "k1", title: "T", message: "M" });
    await settle();
    expect(useUI.getState().confirm).not.toBeNull();

    useUI.getState().withdrawConfirm("k1");

    await expect(p).resolves.toBe(false);
    expect(useUI.getState().confirm).toBeNull();
  });

  it("withdraws a prompt that has not appeared yet", async () => {
    // The asker torn down inside askConfirm's deferral gap. The modal must
    // never reach the screen.
    const p = useUI.getState().askConfirm({ key: "k2", title: "T", message: "M" });
    useUI.getState().withdrawConfirm("k2");
    await settle();

    expect(useUI.getState().confirm).toBeNull();
    await expect(p).resolves.toBe(false);
  });

  it("leaves other prompts alone", async () => {
    const p = useUI.getState().askConfirm({ key: "mine", title: "T", message: "M" });
    await settle();

    useUI.getState().withdrawConfirm("someone-else");

    expect(useUI.getState().confirm?.req.title).toBe("T");
    useUI.getState().resolveConfirm(true);
    await expect(p).resolves.toBe(true);
  });

  it("reports a withdrawn checkbox prompt as unchecked, not undefined", async () => {
    const p = useUI.getState().askConfirm({
      key: "k3",
      title: "T",
      message: "M",
      checkbox: { label: "Also delete the branch" },
    });
    await settle();

    useUI.getState().withdrawConfirm("k3");

    await expect(p).resolves.toEqual({ confirmed: false, checked: false });
  });
});
