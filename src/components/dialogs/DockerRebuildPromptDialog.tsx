// Prompt shown right before a Docker-mode task's agent launches, when the
// sandbox image is due for a rebuild per Settings.docker_rebuild_frequency
// (off/daily/weekly, default daily). Agent CLIs baked into the image are
// unpinned/always-latest, so without this nudge an old image just keeps
// running whatever it happened to install last time it was built.
//
// Three actions, not a confirm-style yes/no: "Rebuild now" (default focus -
// the common case), "Skip for now" one click away for someone in a hurry, and
// "Always rebuild", which does this one AND stops asking. The last exists
// because the prompt's whole justification is that a rebuild delays the
// launch you just asked for; once you have decided you always want it, being
// asked every time is the annoyance rather than the safeguard. It writes a
// setting rather than a session flag, and Settings -> Docker Sandbox can undo
// it. The frequency selector is inline so changing your mind about how often
// this should ask doesn't require a trip to Settings.

import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useBackendSettings } from "@/components/settings/Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { Container, RotateCw, SkipForward, Clock, Infinity as InfinityIcon } from "lucide-react";

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
        {/* Build, but do not make this launch wait on it. The rebuild exists
            to stop an agent running a stale binary, and someone who wants to
            start working NOW should not have to choose between that and a
            several-minute wait: the image lands for the NEXT agent instead. */}
        <Button
          variant="ghost"
          type="button"
          title="Start the rebuild now and launch this agent immediately on the current image. The new one is used by the next agent."
          onClick={() => resolve("background")}
        >
          <Clock className="h-3.5 w-3.5" /> Rebuild in background
        </Button>
        {/* Rebuilds now AND stops asking. Hidden when the frequency is
            "off", where there is no schedule to defer to and the button
            would promise something it cannot do. */}
        {frequency !== "off" && (
          <Button
            variant="secondary"
            type="button"
            title="Rebuild now, and from now on rebuild on this schedule without asking. Reversible in Settings → Docker Sandbox."
            onClick={() => resolve("always")}
          >
            <InfinityIcon className="h-3.5 w-3.5" /> Always rebuild
          </Button>
        )}
        <Button variant="primary" type="button" autoFocus onClick={() => resolve("rebuild")}>
          <RotateCw className="h-3.5 w-3.5" /> Rebuild now
        </Button>
      </div>
    </AppDialog>
  );
}
