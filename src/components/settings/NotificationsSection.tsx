// Notifications and status: how Termic tells you an agent needs you, both
// out of the app (desktop notification, sound) and inside it (the tab and
// sidebar indicators).

import { ensureNotifyPermission, previewCompletionSound } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { usePrefs } from "@/store/prefs";
import { useApp } from "@/store/app";
import { Block, SectionTitle, Toggle } from "./Controls";
import { cn } from "@/lib/utils";
import { COMPLETION_SOUND_OPTIONS, COMPLETION_SOUND_SUPPORTED } from "@/lib/notificationSounds";

export function NotificationsSection() {
  const desktopNotifications = usePrefs(s => s.desktopNotifications);
  const setDesktopNotifications = usePrefs(s => s.setDesktopNotifications);
  const completionSound = usePrefs(s => s.completionSound);
  const setCompletionSound = usePrefs(s => s.setCompletionSound);
  const completionSoundId = usePrefs(s => s.completionSoundId);
  const setCompletionSoundId = usePrefs(s => s.setCompletionSoundId);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const setSettledHighlight = usePrefs(s => s.setSettledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const setWorkingIndicator = usePrefs(s => s.setWorkingIndicator);

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title="Notifications" />

      <Block first>
        <Toggle
          label="Desktop notifications"
          hint="Notify when an inactive agent finishes or rings the bell. Clicking back in jumps to that tab."
          value={desktopNotifications}
          onChange={(v) => {
            setDesktopNotifications(v);
            // Trigger the macOS permission prompt the moment the user opts
            // in, so the dialog appears in context instead of mid-task.
            if (v) ensureNotifyPermission();
          }}
        />
      </Block>

      {/* macOS-only: the sound catalog is macOS system-sound names (plus a
          .caf installed into ~/Library/Sounds) — none resolve elsewhere. */}
      {COMPLETION_SOUND_SUPPORTED && (
      <Block>
        {/* The sound plays INSIDE the desktop notification — with
            notifications off it can never fire, so lock the controls
            instead of letting Preview suggest otherwise. */}
        <div className={cn(!desktopNotifications && "pointer-events-none opacity-50 select-none")}>
        <Toggle
          label="Completion sound"
          hint="Pick which sound plays inside desktop notifications when an inactive agent finishes a turn. Default: Funk."
          value={completionSound}
          onChange={setCompletionSound}
        />
        <div className="mt-3 max-w-sm">
          <div className="flex items-center gap-2">
            <select
              value={completionSoundId}
              onChange={(e) => setCompletionSoundId(e.target.value as typeof completionSoundId)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]"
            >
              {COMPLETION_SOUND_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="md"
              className="h-9 shrink-0"
              onClick={() => {
                // Preview with a real project · task title so the
                // banner looks exactly like an agent-finished notification.
                const st = useApp.getState();
                const task =
                  st.tasks.find(w => w.id === st.activeTaskId && !w.archived) ??
                  st.tasks.find(w => !w.archived);
                const proj = task && st.projects.find(p => p.id === task.project_id);
                const title = task && proj?.name
                  ? `${proj.name} · ${task.name || "task"}`
                  : (task?.name || "project · task");
                previewCompletionSound(completionSoundId, { title, body: "agent finished" });
              }}
              title="Play a preview of the selected completion sound"
            >
              Preview
            </Button>
          </div>
        </div>
        </div>
        {!desktopNotifications && (
          <p className="mt-2 text-[12px] text-[var(--color-fg-faint)]">
            Turn on Desktop notifications above to enable completion sounds.
          </p>
        )}
      </Block>
      )}

      <Block>
        <Toggle
          label="Work-done indicator"
          hint="Color a task's agent icon when its agent finishes a turn and is waiting on you."
          value={settledHighlight}
          onChange={setSettledHighlight}
        />
      </Block>

      <Block>
        <Toggle
          label="Work-in-progress indicator"
          hint="Show a spinner on an agent's tab and sidebar icon while it's working. On by default. Relies on work detection, which can occasionally misfire on noisy TUIs; a stuck spinner auto-clears after a few minutes."
          value={workingIndicator}
          onChange={setWorkingIndicator}
        />
      </Block>
    </div>
  );
}
