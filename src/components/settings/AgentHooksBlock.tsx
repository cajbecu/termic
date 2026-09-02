// Settings → Agents & Terminals → Agent hooks.
//
// It sits with the AGENTS because it writes into an agent's own config and
// changes how that agent reports its state. It lived under Notifications
// first, on the reasoning that the four indicators there are all downstream of
// work-state detection: true, and beside the point, since Notifications is
// where you choose whether to be TOLD rather than how termic KNOWS. The tell
// was that the arrangement needed a signpost on the Agents page pointing at
// it, and a cross reference is usually evidence a thing is in the wrong place.
//
// One table above the per-agent tabs, not a field on each card: the per-agent
// statuses ("not needed", "not supported yet") only read as coverage when they
// sit next to each other, and it is a decision made once, not per agent.
//
// One row per DETECTED agent, each with its own action. Deliberately not a
// single master switch: the consent question differs per agent (a shell script
// in ~/.claude is not the same ask as a JS module running in-process inside
// opencode), and hiding that behind one toggle would be dishonest.
//
// Each row's action covers BOTH that agent's targets, host and its Docker
// config dir. Docker needs no separate consent because termic owns that
// directory, but a user who declines for an agent must never find hooks
// installed for it inside a container. See docs/agent-hooks.md.

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { agentHooksInstall, agentHooksPlan, agentHooksRemove, agentHooksStatus } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { agentDisplayName } from "@/lib/agents";
import type { AgentHookStatus, HookPlan } from "@/lib/types";

/** Anchor the Agents section's link targets, so the jump lands ON the block
 *  rather than at the top of Notifications with the reader hunting for it. */
export const AGENT_HOOKS_HIGHLIGHT = "agent-hooks";

export function AgentHooksBlock() {
  const detectedClis = useApp(s => s.detectedClis);
  const agents = useApp(s => s.agents);
  const [status, setStatus] = useState<Record<string, AgentHookStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Record<string, string>>({});
  // Disclosure, per agent. These users read shell for a living, so the honest
  // move is to show the actual scripts rather than describe them.
  const [plan, setPlan] = useState<Record<string, HookPlan>>({});
  const [open, setOpen] = useState<string | null>(null);
  // COLLAPSED by default. Expanded, this pushed the per-agent tabs (the reason
  // anyone opens this page) below the fold behind two paragraphs of protocol
  // detail. That detail is right for someone deciding to let termic write into
  // their agent config and wrong as the first thing on the page, so it lives
  // behind the toggle and the collapsed row carries only what it is and how
  // many agents are wired.
  const [expanded, setExpanded] = useState(false);
  // Arriving from the Agents section's link: scroll to this block and flash it
  // once. Same one-shot contract as GeneralSection's, so a later manual visit
  // to Notifications does not re-flash something the reader is already on.
  const settingsHighlight = useApp(s => s.view.settingsHighlight);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (settingsHighlight !== AGENT_HOOKS_HIGHLIGHT) return;
    useApp.getState().clearSettingsHighlight();
    document.getElementById(`setting-${AGENT_HOOKS_HIGHLIGHT}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(t);
  }, [settingsHighlight]);

  const toggleDetails = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!plan[id]) {
      try {
        const next = await agentHooksPlan(id);
        setPlan(p => ({ ...p, [id]: next }));
      } catch { /* the row still works without the disclosure */ }
    }
  };

  // Only agents actually on PATH. Offering to wire an agent the user does not
  // have is noise, and the row would have nothing true to say.
  const present = agents
    .filter(a => a.id !== "shell" && detectedClis[a.id]?.found)
    .map(a => a.id);

  // ...and of those, only the ones this can actually wire. A row reading
  // "not supported yet" or "not needed, its terminal already reports this" is
  // a row you can do nothing with, and there were more of those than real ones,
  // which made the list read as mostly unavailable. The unsupported agents are
  // still described in docs/agent-hooks.md, where the reasoning belongs.
  const wirable = present.filter(id => status[id]?.supported);
  const installedCount = wirable.filter(id => status[id]?.host.installed).length;

  const refresh = useCallback(async (ids: string[]) => {
    const rows = await Promise.all(
      ids.map(id => agentHooksStatus(id).then(s => [id, s] as const).catch(() => null)),
    );
    setStatus(Object.fromEntries(rows.filter(Boolean) as (readonly [string, AgentHookStatus])[]));
  }, []);

  useEffect(() => { if (present.length) void refresh(present); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [present.join(","), refresh]);

  const act = async (id: string, install: boolean) => {
    setBusy(id);
    setFailure(f => ({ ...f, [id]: "" }));
    try {
      const next = install ? await agentHooksInstall(id) : await agentHooksRemove(id);
      setStatus(s => ({ ...s, [id]: next }));
      // Live tabs read this to decide whether the title may still end a turn,
      // so it has to change with the install rather than at the next restart.
      await useApp.getState().refreshAgentHooks();
    } catch (e) {
      setFailure(f => ({ ...f, [id]: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  // Text sizes here are explicit px, matching Controls.tsx (label 14, hint
  // 12.5, dense 12). Tailwind's `text-sm` / `text-xs` is a SECOND scale that
  // resolves against the root font size, so using it rendered this whole block
  // a notch below its neighbours and drew a "why did you introduce a new text
  // size" straight away. Match the surrounding settings, do not invent.
  // Nothing to offer, so nothing to show. Also covers the moment before
  // status resolves, where every row would say "checking...".
  if (!wirable.length) return null;

  return (
    <div
      id={`setting-${AGENT_HOOKS_HIGHLIGHT}`}
      className={cn(
        "rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-4 py-3",
        flash && "ring-2 ring-[var(--color-accent)]",
      )}
    >
      {/* The whole thing collapsed is ONE row: what it is, how many agents are
          wired, and a way in. Everything else is behind the toggle. */}
      <button
        type="button"
        data-testid="agent-hooks-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", expanded && "rotate-90")} />
        <span className="text-[14px] font-semibold text-[var(--color-fg)]">Agent hooks</span>
        <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-[var(--color-accent)]">
          Experimental
        </span>
        <span className="ml-auto text-[12.5px] text-[var(--color-fg-dim)]">
          {installedCount > 0
            ? `${installedCount} of ${wirable.length} installed`
            : "Let agents report their own state"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
            Termic installs a small script into the agent&apos;s own config so it
            reports when a turn starts, when it needs you, and when it is done.
            Without it Termic infers all three from the terminal, which is
            usually right: Claude paints its idle glyph while blocked on a
            permission prompt, and again while its subagents run, so a task can
            read as finished when it is not. Removal puts the config back byte
            for byte, and each row shows exactly what it writes.
          </p>
          <div className="flex flex-col gap-2">
            {wirable.map(id => {
              // `wirable` already filtered to supported agents, so `st` exists.
              const st = status[id]!;
              const err = failure[id] || st.host.error || "";
              // `disableAllHooks` in the user's own config means an install would
              // never fire. Saying "installed" there would be a lie.
              const blocked = st.host.disabled_all;
              return (
                <div key={id} className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[14px] font-medium">{agentDisplayName(id, agents)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-[var(--color-fg-dim)]">
                        {blocked ? "disableAllHooks is set in this config"
                          : st.host.installed ? "installed"
                          : "not installed"}
                      </span>
                      {!blocked && (
                        <Button
                          variant={st.host.installed ? "ghost" : "primary"}
                          disabled={busy === id}
                          onClick={() => act(id, !st.host.installed)}
                        >
                          {busy === id ? "..." : st.host.installed ? "Remove" : "Install"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Name the files BEFORE writing, not after, and offer the
                      whole thing rather than a summary of it. */}
                  {!blocked && (
                    <button
                      type="button"
                      onClick={() => void toggleDetails(id)}
                      className="self-start text-[12.5px] text-[var(--color-fg-dim)] underline decoration-dotted hover:text-[var(--color-fg)]"
                    >
                      {open === id ? "Hide what this installs" : "Show exactly what this installs"}
                    </button>
                  )}
                  {open === id && plan[id] && (
                    <div className="flex flex-col gap-2 rounded bg-[var(--color-bg-subtle)] p-2 text-[12px]">
                      <div>
                        <span className="text-[var(--color-fg-subtle)]">Config file: </span>
                        <code className="break-all">{plan[id].config_path}</code>
                        {plan[id].config_is_shared && (
                          <span className="text-[var(--color-fg-subtle)]"> (yours; termic merges into it)</span>
                        )}
                      </div>
                      <div>
                        <div className="text-[var(--color-fg-subtle)]">Added to that file:</div>
                        <pre className="overflow-x-auto whitespace-pre">{plan[id].config_fragment}</pre>
                      </div>
                      {plan[id].entries.map(en => (
                        <div key={en.event}>
                          <div className="text-[var(--color-fg-subtle)]">
                            <code>{en.event}</code> reports <b>{en.reports}</b>, and runs:
                          </div>
                          <div className="break-all"><code>{en.script_path}</code></div>
                          <pre className="overflow-x-auto whitespace-pre">{en.script_body}</pre>
                        </div>
                      ))}
                      {plan[id].notes.map((n, i) => (
                        <p key={i} className="text-[var(--color-fg-subtle)]">{n}</p>
                      ))}
                    </div>
                  )}
                  {err && <p className="text-[12.5px] text-[var(--color-danger)]">{err}</p>}
                </div>
                  );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
