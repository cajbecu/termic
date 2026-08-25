// The two ways to turn code intelligence on, and the one way to turn it off.
//
// Shared by the chip on the editor's path bar and the offer row in Search
// Everywhere, because they ask the same question and answering it differently
// in two places is how a feature stops being understandable. The caller
// decides where this floats; this decides what it says.
//
// **Two ON buttons, not one.** A grant is per checkout and temporary: it
// lapses when the checkout's last task closes, which is what stops a five
// minute code read resurrecting a multi-gigabyte server months later. That is
// the right default and the wrong thing to make somebody repeat every day on a
// repo they live in. So: this task, or always for this project.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { useCodeIntel, checkoutRoot, grantKey } from "@/store/codeIntel";
import { languageName } from "@/lib/lsp/languages";
import { MEMORY_NOTE, serverFor } from "@/lib/lsp/serverNames";
import { codeIntelNameLower } from "@/lib/lsp/featureName";
import { lspOffer, type LspOffer } from "@/lib/lsp/install";
import { projectUpdate } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** The narrowest standing instruction that covers where the reader is
 *  standing. A worktree needs "all" (one server PER worktree, which
 *  multiplies); the main checkout needs only "main" (one server per language,
 *  shared by every task on it). Widening past that spends memory on a guess. */
function autoFor(isMainCheckout: boolean): "main" | "all" {
  return isMainCheckout ? "main" : "all";
}

export function CodeIntelActions({ taskId, server, onDone, compact, focusedAction, disclosed }: {
  taskId: string;
  /** Server id ("python"), not a language name. */
  server: string;
  /** Called after any action, so a popover can close itself. */
  onDone?: () => void;
  /** Which of these buttons the keyboard is on, by position, or null when the
   *  keyboard is elsewhere. An INDEX rather than a flag because ← / → walk
   *  along the row: a boolean could only ever light the first one, so "Always"
   *  was reachable by mouse and by nothing else. */
  focusedAction?: number | null;
  /** Skip the memory-cost confirm. ONLY for a caller that prints the figure
   *  itself: the prompt is the disclosure, so silencing it without showing
   *  the number somewhere is taking the consent away rather than moving it.
   *  Search Everywhere prints it on the offer row, and a modal stacked on top
   *  of an open dialog to repeat one number is a worse place to read it. */
  disclosed?: boolean;
  /** Side by side, label only. A popover has room for a stacked pair with a
   *  line of explanation under each; a LIST ROW does not, and the stacked
   *  version turned one row of Search Everywhere into a 200px block that
   *  shoved the results off the screen. Same actions, same order. */
  compact?: boolean;
}) {
  const task = useApp(s => s.tasks.find(t => t.id === taskId));
  // See `lib/lsp/featureName.ts`: navigation until the checker is on.
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const project = useApp(s => (task ? s.projects.find(p => p.id === task.project_id) : undefined));
  const root = task ? checkoutRoot(task, project) : "";
  const armed = useCodeIntel(s => (s.grants[grantKey(root, server)]?.length ?? 0) > 0);
  // Which binary would run, so the cost quoted is the cost of the process that
  // will actually start (zuban and ty are not the same bill).
  const [offer, setOffer] = useState<LspOffer | null>(null);
  useEffect(() => {
    if (!root) return;
    let alive = true;
    lspOffer(root, server).then(o => { if (alive) setOffer(o); }).catch(() => {});
    return () => { alive = false; };
  }, [root, server]);
  const auto = project?.code_intel_auto ?? "off";
  const always = auto === "all" || (auto === "main" && !!task?.is_main_checkout);

  if (!task) return null;

  /**
   * Arm, disclosing the cost the first time.
   *
   * The figure is the point of consent and it lives HERE rather than in either
   * caller, because a person who turned this on from Search Everywhere agreed
   * to exactly the same thing as one who used the chip. `confirmBeforeCodeIntel`
   * is the "don't ask again" they ticked, so the second repo is one click.
   */
  const armNow = async (): Promise<boolean> => {
    const exe = offer?.exe ?? null;
    if (!disclosed && usePrefs.getState().confirmBeforeCodeIntel) {
      const res = await useUI.getState().askConfirm({
        title: `Turn on ${codeIntelNameLower(typeChecking)}?`,
        message: [
          MEMORY_NOTE[serverFor(exe, server)]
            ?? "A language server can hold a lot of memory and does not release it until it stops.",
          task.is_main_checkout
            ? "It runs once for this checkout, however many tasks share it, so a second task on the main checkout costs nothing extra."
            : "It runs once for THIS worktree. Every other worktree with it on runs its own copy, with its own index.",
          "It stops when this checkout's last task is closed or archived, so turning it on now does not commit the machine to it forever.",
        ].join("\n\n"),
        confirmLabel: "Turn on",
        dontAskAgain: true,
        // Keyed: the pane can be closed (or the task archived) while the
        // prompt stands, and an un-withdrawn confirm blocks the whole window.
        key: `code-intel:${grantKey(root, server)}`,
      });
      // The checkbox is reported at dismissal, so ticking it and pressing
      // Escape must not silence a prompt they never accepted.
      if (!res.confirmed) return false;
      if (res.dontAskAgain) usePrefs.getState().setConfirmBeforeCodeIntel(false);
    }
    usePrefs.getState().setCodeIntelligence(true);
    useCodeIntel.getState().arm(grantKey(root, server), taskId);
    return true;
  };

  const setAuto = async (value: "off" | "main" | "all") => {
    if (!project || project.code_intel_auto === value) return;
    try {
      await projectUpdate({ ...project, code_intel_auto: value });
      await useApp.getState().loadAll();
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
  };

  const turnOff = async () => {
    // The standing instruction goes FIRST, and this order is the whole fix.
    // Releasing first flipped `armed` to false while the project still said
    // "always", and the chip's auto-arm effect re-armed on the very next
    // render, while this function was still suspended on the IPC. The refcount
    // check below then saw a holder, the server was never stopped, and the
    // switch appeared to do nothing.
    if (always) await setAuto("off");
    useCodeIntel.getState().release(grantKey(root, server), taskId);
    // A sibling task on this checkout may still be using it; stopping then
    // would take navigation away from a task nobody touched.
    if ((useCodeIntel.getState().grants[grantKey(root, server)] ?? []).length === 0) {
      const { stopClient } = await import("@/lib/lsp/host");
      await stopClient(root, server);
    }
  };

  const Action = ({ id, index, label, hint, onClick, primary }: {
    /** Stable, and NOT derived from the label: the label shortens in compact
     *  mode and is the sort of copy that changes, which would silently take
     *  every spec driving this button with it. */
    id: string;
    /** Position in this row, which is what ← / → address. */
    index: number;
    label: string; hint: string; onClick: () => void; primary?: boolean;
  }) => (
    <button
      type="button"
      data-testid={`code-intel-${id}`}
      // The hint becomes the tooltip when there is no room to print it.
      title={compact ? hint : undefined}
      onMouseDown={(e) => { e.preventDefault(); onClick(); onDone?.(); }}
      className={cn(
        "rounded-md text-left",
        compact
          ? "shrink-0 px-2.5 py-1 text-[12px] font-medium"
          : "flex w-full flex-col items-start px-2.5 py-1.5",
        // In a LIST, both actions are outlined and the keyboard's position is
        // what is filled in: the row is reachable by arrow keys, so the reader
        // needs to see which of the two Enter would press. A permanently
        // filled primary looked like focus and lied about it.
        compact
          ? cn(
            // BOTH outlined, always. Filling the focused one made it look like
            // a primary action that happened to be selected; a ring says "this
            // is where the keyboard is" without changing what the button is.
            "border text-[var(--color-fg)] hover:bg-[var(--color-hover)]",
            // ONE edge, not two. A ring with an offset leaves a gap between
            // the button's own border and the ring, and the gap paints the row
            // behind it: a dark line inside an accent line, which reads as a
            // double border rather than as focus. Same colour, no offset, so
            // the border and the ring sit flush and look like a single 2px
            // accent edge.
            focusedAction === index
              ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]"
              : "border-[var(--color-border)]",
          )
          : primary
            ? "bg-[var(--color-accent-deep)] text-white hover:opacity-90"
            // A border only where this button stands ALONE. In the popover it
            // sits inside a bordered panel, and drawing another one around
            // each row made a box inside a box; there it behaves like a menu
            // item, which is what it is.
            : "text-[var(--color-fg)] hover:bg-[var(--color-hover)]",
      )}
    >
      <span className={cn(!compact && "text-[12.5px] font-medium")}>{label}</span>
      {!compact && (
        <span className={cn("text-[11px]", primary ? "text-white/75" : "text-[var(--color-fg-faint)]")}>
          {hint}
        </span>
      )}
    </button>
  );

  return (
    <div className={cn(compact ? "flex items-center gap-1.5" : "flex w-[240px] flex-col gap-1.5")}>
      {armed ? (
        <Action
          id="turn-off"
          index={0}
          label="Turn off"
          hint={always ? "Also stops arming it automatically" : "Stops the server for this checkout"}
          onClick={() => void turnOff()}
        />
      ) : (
        <>
          <Action
            id="turn-on-for-this-task"
            index={0}
            label={compact ? "This task" : "Turn on for this task"}
            hint="Ends when this checkout's last task closes"
            onClick={() => { void armNow(); }}
            primary
          />
          <Action
            id="always-for-this-project"
            index={1}
            label={compact ? "Always" : "Always for this project"}
            hint={`Arms every ${languageName(server)} task in this project`}
            onClick={() => {
              void (async () => {
                // The standing instruction only follows a yes: declining the
                // cost must not leave the project set to pay it on every
                // future task.
                if (await armNow()) await setAuto(autoFor(!!task.is_main_checkout));
              })();
            }}
          />
        </>
      )}
    </div>
  );
}
