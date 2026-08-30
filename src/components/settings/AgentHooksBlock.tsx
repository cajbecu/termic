// Settings → Notifications → agent hooks.
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
    <SubSection
      title="Exact needs-you detection"
      hint="Installs a small hook into an agent's own config so Termic knows the moment it is waiting on you, instead of guessing from the terminal. Off by default."
    >
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
  );
}
