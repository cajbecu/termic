// Prompt shown right before a Docker-mode task's agent launches, when the
// sandbox image is due for a rebuild per Settings.docker_rebuild_frequency
// (off/daily/weekly, default daily). Agent CLIs baked into the image are
// unpinned/always-latest, so without this nudge an old image just keeps
// running whatever it happened to install last time it was built.
//
// Deliberately two big actions, not a confirm-style yes/no: "Rebuild now"
// (default focus - the common case) and "Skip for now", one click away for
// someone in a hurry who doesn't want to wait on a rebuild before their
// agent starts. The frequency selector is inline so changing your mind
// about how often this should ask doesn't require a trip to Settings.

import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useBackendSettings } from "@/components/settings/Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { Container, RotateCw, SkipForward } from "lucide-react";

export function DockerRebuildPromptDialog() {
  const prompt = useUI(s => s.dockerRebuildPrompt);
  const resolve = useUI(s => s.resolveDockerRebuildPrompt);
  // Own settings fetch (not the caller's): this dialog can outlive whatever
  // triggered it and just needs the current frequency to display/edit.
  const { settings, patch } = useBackendSettings();

  if (!prompt) return null;
  const frequency = settings?.docker_rebuild_frequency ?? "daily";

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve("skip"); }}
      title="Rebuild the Docker sandbox image?"
      className="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1 text-[13.5px] text-[var(--color-fg-dim)] leading-relaxed">
        <p className="flex items-start gap-2.5">
          <Container className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>
            <span className="font-medium text-[var(--color-fg)]">"{prompt.taskName}"</span> runs its agent
            inside the Docker sandbox image. {describeLastBuildDate(prompt.lastBuiltDate)} Agent CLIs baked into it
            update constantly, so an old image can quietly fall behind.
          </span>
        </p>

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-faint)]">
            Nudge me to rebuild
          </div>
          <DockerRebuildFrequencyPicker value={frequency} onChange={v => patch({ docker_rebuild_frequency: v })} />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve("skip")}>
          <SkipForward className="h-3.5 w-3.5" /> Skip for now
        </Button>
        <Button variant="primary" type="button" autoFocus onClick={() => resolve("rebuild")}>
          <RotateCw className="h-3.5 w-3.5" /> Rebuild now
        </Button>
      </div>
    </AppDialog>
  );
}
