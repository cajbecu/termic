// Shared Off / Daily / Weekly pill selector for Settings.docker_rebuild_frequency,
// used by both Settings → Docker Sandbox and DockerRebuildPromptDialog (the inline
// "change your mind" control on the launch-time nudge).
import { cn } from "@/lib/utils";

const FREQUENCIES: { id: "off" | "daily" | "weekly"; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

export function DockerRebuildFrequencyPicker({ value, onChange }: {
  value: "off" | "daily" | "weekly";
  onChange: (v: "off" | "daily" | "weekly") => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {FREQUENCIES.map(f => {
        const active = value === f.id;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            className={cn(
              "rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors",
              active
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)]",
            )}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}
