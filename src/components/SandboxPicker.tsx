// Single flat selector for "how is this task caged", replacing the earlier
// two-tier SandboxEngineSelector (engine) + SandboxModeSelector (Seatbelt
// submode) split. Five peer cards: Off, Seatbelt's three modes, and Docker.
// Still a UI-only view over the SAME two independent backend fields
// (`sandbox_mode` / `docker_sandbox_enabled`, see SandboxSelection in
// lib/types.ts) - no new data model, just one picker instead of two.
import { cn } from "@/lib/utils";
import type { SandboxMode, SandboxSelection } from "@/lib/types";
import { SANDBOX_VISUALS, sandboxPickerLabel, SandboxIcon, DockerSandboxIcon, DOCKER_SANDBOX_COLOR } from "@/components/SandboxIcon";

/** Row-major order: OFF / ENFORCING (FS) on top, MONITORING / ENFORCING
 *  below, DOCKER on its own row - it's a different MECHANISM, not another
 *  intensity level of the same one, so it reads as a break from the grid
 *  rather than a fifth peer crammed into it. */
const ORDER: SandboxMode[] = ["off", "enforce-fs", "monitor", "enforce"];

export function SandboxPicker({
  value, onChange, seatbeltUnavailable = false, dockerOffered, dockerUnavailableReason, compact = false,
}: {
  value: SandboxSelection;
  onChange: (s: SandboxSelection) => void;
  /** Disable every Seatbelt card except OFF (sandbox is macOS-only). */
  seatbeltUnavailable?: boolean;
  /** Docker card enabled only once Settings -> Docker Sandbox is on AND an
   *  image is built - there's nothing for it to do otherwise. */
  dockerOffered: boolean;
  /** Tooltip shown on the disabled Docker card explaining why. */
  dockerUnavailableReason?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {ORDER.map(id => {
          const v = SANDBOX_VISUALS[id];
          const active = value === id;
          const unsupported = seatbeltUnavailable && id !== "off";
          return (
            <button
              key={id}
              type="button"
              disabled={unsupported}
              onClick={() => onChange(id)}
              title={unsupported ? "Sandbox is macOS-only (requires sandbox-exec)." : v.desc}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
                compact ? "px-3 py-2" : "px-3 py-2.5",
                active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
                unsupported && "opacity-40 cursor-not-allowed",
              )}
              style={active ? { borderColor: v.color, background: `color-mix(in srgb, ${v.color} 10%, transparent)` } : undefined}
            >
              <div className="flex items-center gap-1.5">
                {/* Icon always wears its mode's tone (even when not selected)
                    so the states are color-coded at a glance. */}
                <SandboxIcon mode={id} className="h-4 w-4 shrink-0" />
                <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>
                  {sandboxPickerLabel(id)}
                </span>
              </div>
              <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{v.desc}</span>
            </button>
          );
        })}
      </div>

      {/* Docker: full-width row of its own, visually breaking from the
          Seatbelt grid above it since it's a different cage mechanism, not
          another intensity level. */}
      {(() => {
        const active = value === "docker";
        const disabled = !dockerOffered;
        const desc = "Filesystem cage inside a container. Network is unrestricted for now.";
        const title = disabled
          ? (dockerUnavailableReason ?? "Enable Docker sandbox and build the image in Settings → Docker Sandbox first.")
          : desc;
        return (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("docker")}
            title={title}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
              compact ? "px-3 py-2" : "px-3 py-2.5",
              active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              disabled && "opacity-40 cursor-not-allowed",
            )}
            style={active ? { borderColor: DOCKER_SANDBOX_COLOR, background: `color-mix(in srgb, ${DOCKER_SANDBOX_COLOR} 10%, transparent)` } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <DockerSandboxIcon className="h-4 w-4 shrink-0" />
              <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>
                DOCKER CONTAINER
              </span>
            </div>
            <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{desc}</span>
          </button>
        );
      })()}
    </div>
  );
}

/** Shown under the picker when "Docker Container" is the picked selection -
 *  the one thing every Docker surface in this app repeats: it's currently
 *  a filesystem-only cage. */
export function DockerEngineNote({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>
      Filesystem cage only for now: the agent can only touch what termic mounts, but{" "}
      <u>network access is unrestricted</u> (a network allow-list for Docker mode is planned once this is stable).
    </div>
  );
}
