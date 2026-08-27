// Sandbox settings. Its own page because this is the one area of settings
// where a wrong value has a security consequence, and because the three
// controls used to sit scattered between "Completion sound" and "Hidden
// files" in General. See docs/sandbox.md for what the cage actually does.

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";
import { settingsSave, sandboxAvailable, dockerImageStatus, type DockerImageStatus } from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { usePrefs } from "@/store/prefs";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { SandboxPicker, DockerEngineNote } from "@/components/SandboxPicker";
import { cleanLines } from "@/lib/utils";

export function SandboxSection() {
  const { settings, store } = useBackendSettings();
  const [busy, setBusy] = useState(false);
  // Global sandbox defaults. Stored line-by-line as strings so the
  // user can edit mid-line without the array round-trip dropping
  // their cursor.
  const [sbRw, setSbRw]       = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [sbOriginal, setSbOriginal] = useState({ rw: "", hosts: "" });

  const globalDefaultSandboxKind = usePrefs(s => s.globalDefaultSandboxKind);
  const setGlobalDefaultSandboxKind = usePrefs(s => s.setGlobalDefaultSandboxKind);
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);
  const setSandboxBypassPermissions = usePrefs(s => s.setSandboxBypassPermissions);

  // Same two gates the picker needs everywhere else it appears: Seatbelt
  // is macOS-only, Docker needs the global switch on AND an image built.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  const [dockerImage, setDockerImage] = useState<DockerImageStatus | null>(null);
  useEffect(() => {
    sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false));
    dockerImageStatus().then(setDockerImage).catch(() => {});
  }, []);
  const dockerOffered = !!settings?.docker_sandbox_enabled && !!dockerImage?.available;

  const hydrated = useRef(false);
  useEffect(() => {
    if (!settings || hydrated.current) return;
    hydrated.current = true;
    const rw    = (settings.sandbox_default_rw_paths      ?? []).join("\n");
    const hosts = (settings.sandbox_default_allowed_hosts ?? []).join("\n");
    setSbRw(rw); setSbHosts(hosts);
    setSbOriginal({ rw, hosts });
  }, [settings]);

  const sbDirty = sbRw !== sbOriginal.rw || sbHosts !== sbOriginal.hosts;

  async function saveSb() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = {
        ...settings,
        sandbox_default_rw_paths:      cleanLines(sbRw),
        sandbox_default_allowed_hosts: cleanLines(sbHosts),
      };
      await settingsSave(next);
      store(next);
      setSbOriginal({ rw: sbRw, hosts: sbHosts });
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title="Sandbox" />

      {/* Global sandbox default. The New task dialog's picker starts here
          whenever neither the user's own last-used habit nor the
          project's own default_sandbox_mode is in effect - one app-wide
          pick (including Docker) instead of per-project bookkeeping.
          Already-created tasks aren't affected: the pin is captured at
          creation. */}
      <Block first>
        <div className="text-[14px] font-medium">Sandbox new tasks by default</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          The New task dialog's sandbox picker starts here for every project, unless the project sets its own
          default or you've already picked something for a previous task (that habit wins). Individual projects
          can still override (Settings → Repositories).
        </div>
        <div className="mt-3">
          <SandboxPicker
          onEnableDocker={() => { useApp.getState().openSettings("docker"); }}
            value={globalDefaultSandboxKind}
            onChange={setGlobalDefaultSandboxKind}
            seatbeltUnavailable={osSandboxOk === false}
            dockerOffered={dockerOffered}
            dockerUnavailableReason="Enable Docker sandbox and build the image in Settings → Docker Sandbox first."
          />
          {globalDefaultSandboxKind === "docker" && (
            <div className="mt-2">
              <DockerEngineNote />
            </div>
          )}
        </div>
      </Block>

      {/* Bypass-permissions default for sandboxed agents. When on, a
          sandboxed agent spawns with its "auto-approve everything" flag
          regardless of the YOLO toggle — the seatbelt is the real
          boundary, the agent's own prompts are just friction. Affects
          new PTY spawns; respawn (⌘R / new tab) to pick up a change. */}
      <Block>
        <Toggle
          label="Bypass permissions in sandboxed tasks"
          hint="When on, agents in a sandboxed task skip their own permission prompts. The macOS seatbelt is the real boundary. Turn off to make sandboxed agents still ask. Applies to newly spawned terminals."
          value={sandboxBypassPermissions}
          onChange={setSandboxBypassPermissions}
        />
      </Block>

      {/* Global sandbox lists. Joined with each project's per-repo
          lists when a task gets created with sandbox enabled,
          and pre-filled into the Edit Sandbox dialog when the user
          enables the cage from scratch. Editing these only affects
          NEW tasks — existing ones froze a copy at creation. */}
      <Block>
        <div className="text-[14px] font-medium">Global sandbox defaults</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          One per line. Wildcards (<code>*.example.com</code>) for hosts; <code>$HOME</code> + <code>~</code> expand for paths.
          Merged with each project's own lists when a task is created.
        </div>
        <div className="mt-3 flex flex-col gap-4">
          <ListField label="Allowed paths" placeholder={"~/Documents/notes\n~/scratch"} value={sbRw} onChange={setSbRw} />
          <ListField label="Allowed hosts" placeholder={"*.example.com\nbitbucket.org"} value={sbHosts} onChange={setSbHosts} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!sbDirty || busy} onClick={saveSb}>
            {busy ? "Saving…" : "Save defaults"}
          </Button>
        </div>
      </Block>
    </div>
  );
}
