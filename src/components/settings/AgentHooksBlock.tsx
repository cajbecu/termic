// Settings → Notifications → Agent hooks.
//
// It lives under Notifications because the four settings above it (desktop
// notifications, completion sound, the done indicator and the in-progress
// spinner) are ALL downstream of work-state detection, and this is where that
// detection comes from. It is the accuracy source for the section, not a fifth
// sibling toggle. Agents links here rather than duplicating the rows per agent:
// the per-agent statuses ("not needed", "not supported yet") only read as
// coverage when they are in one table.
//
// One row per DETECTED agent, each with its own action. Deliberately not a
// single master switch: the consent question differs per agent (a shell script
// in ~/.claude is not the same ask as a JS module running in-process inside
// opencode), and hiding that behind one toggle would be dishonest.
//
// Each row's action covers BOTH that agent's targets, host and its Docker
// config dir. Docker needs no separate consent because termic owns that
// directory, but a user who declines for an agent must never find hooks
// installed for it inside a container. See docs/plans/agent-hooks.md.

import { useCallback, useEffect, useState } from "react";
import { agentHooksInstall, agentHooksPlan, agentHooksRemove, agentHooksStatus } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { SubSection } from "./SubSection";
import { agentDisplayName } from "@/lib/agents";
import type { AgentHookStatus, HookPlan } from "@/lib/types";

/** Why an agent cannot be wired, in the user's terms. An agent that is
 *  installed but unsupported must SAY so rather than appear wired, which is the
 *  mistake the competing implementation makes in the other direction. */
const UNSUPPORTED_REASON: Record<string, string> = {
  codex: "not needed, its terminal already reports this",
  gemini: "not supported yet",
  copilot: "not supported yet",
};

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

  if (!present.length) return null;

  return (
    <div id={`setting-${AGENT_HOOKS_HIGHLIGHT}`} className={flash ? "rounded-md ring-2 ring-[var(--color-accent)]" : undefined}>
    <SubSection
      title="Agent hooks"
      hint="Off by default. Lets each agent report when it starts, when it needs you and when it is done, instead of Termic reading its terminal. That makes every setting above exact rather than best effort."
    >
      {/* The advantage has to be concrete, because the ask is real: this writes
          into the user's own agent config. The measurement is the argument, and
          it is DONE detection, not needs-you, that carries it: needs-you gains
          about six seconds, while done is the difference between a correct
          badge and a wrong one for half an hour. The old copy named only
          needs-you and undersold the feature to the exact audience most likely
          to weigh the tradeoff. */}
      <p className="text-xs leading-relaxed text-[var(--color-fg-subtle)]">
        A terminal is a guess. Claude paints its idle glyph while it is blocked
        on you, and again while its subagents are still working: on an 8.5
        minute run with four of them, its title read as finished for 30% of the
        time the work was still outstanding. A hook is the agent&apos;s own
        word, so a spinner stops early only when the turn really ended.
      </p>
      <div className="flex flex-col gap-2">
        {present.map(id => {
          const st = status[id];
          const reason = UNSUPPORTED_REASON[id] ?? "not supported yet";
          const err = failure[id] || st?.host.error || "";
          // `disableAllHooks` in the user's own config means an install would
          // never fire. Saying "installed" there would be a lie.
          const blocked = st?.host.disabled_all;
          return (
            <div key={id} className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{agentDisplayName(id, agents)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-fg-subtle)]">
                    {!st ? "checking..."
                      : !st.supported ? reason
                      : blocked ? "disableAllHooks is set in this config"
                      : st.host.installed ? "installed"
                      : "not installed"}
                  </span>
                  {st?.supported && !blocked && (
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
              {st?.supported && !blocked && (
                <button
                  type="button"
                  onClick={() => void toggleDetails(id)}
                  className="self-start text-xs text-[var(--color-fg-subtle)] underline decoration-dotted hover:text-[var(--color-fg)]"
                >
                  {open === id ? "Hide what this installs" : "Show exactly what this installs"}
                </button>
              )}
              {open === id && plan[id] && (
                <div className="flex flex-col gap-2 rounded bg-[var(--color-bg-subtle)] p-2 text-xs">
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
              {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}
            </div>
          );
        })}
      </div>
    </SubSection>
    </div>
  );
}
