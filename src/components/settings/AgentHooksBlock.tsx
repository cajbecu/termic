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
import { agentHooksInstall, agentHooksRemove, agentHooksStatus } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { SubSection } from "./SubSection";
import { agentDisplayName } from "@/lib/agents";
import type { AgentHookStatus } from "@/lib/types";

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
              {/* Name the files BEFORE writing, not after. */}
              {st?.supported && !st.host.installed && !blocked && (
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  Will write {st.host.script_dir} and add one entry to {st.host.settings_path}.
                </p>
              )}
              {err && <p className="text-xs text-[var(--color-danger)]">{err}</p>}
            </div>
          );
        })}
      </div>
    </SubSection>
  );
}
