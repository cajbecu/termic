// Top-level "which cage MECHANISM" selector: Off / macOS Seatbelt / Docker
// container. These are two genuinely separate fields on Task
// (`sandbox_mode` vs `docker_sandbox_enabled`, mutually exclusive) - this
// component is what makes them read as ONE choice everywhere a task's
// sandbox is picked, instead of Docker being a bolted-on afterthought only
// reachable from the edit-sandbox dialog after a task already exists.
// When "macOS Seatbelt" is picked, the caller renders SandboxModeSelector
// (hideOff) below this for the Monitor / Enforcing (FS) / Enforcing choice.
import { Shield, ShieldOff, Container, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCKER_SANDBOX_COLOR } from "@/components/SandboxIcon";

export type SandboxEngine = "off" | "seatbelt" | "docker";

interface EngineCard {
  id: SandboxEngine;
  label: string;
  desc: string;
  Icon: LucideIcon;
  color: string;
}

const CARDS: EngineCard[] = [
  { id: "off", label: "OFF", desc: "Full filesystem + network access.", Icon: ShieldOff, color: "var(--color-fg-faint)" },
  { id: "seatbelt", label: "macOS SEATBELT", desc: "Kernel-level cage, runs on this Mac.", Icon: Shield, color: "var(--color-ok)" },
  // Docker's cage never reaches the green "real cage" state Seatbelt's
  // enforce mode does - it's filesystem-only, network stays unrestricted
  // (see DockerEngineNote) - so it wears the same warning red Sidebar.tsx
  // uses for "YOLO on but the cage isn't actually enforced", not its own
  // color. See SandboxIcon.tsx's DOCKER_SANDBOX_COLOR doc comment.
  { id: "docker", label: "DOCKER CONTAINER", desc: "Runs the agent inside a container instead.", Icon: Container, color: DOCKER_SANDBOX_COLOR },
];

export function SandboxEngineSelector({
  engine, onChange, osUnavailable = false, dockerOffered, dockerUnavailableReason, compact = false,
}: {
  engine: SandboxEngine;
  onChange: (e: SandboxEngine) => void;
  /** Disable the Seatbelt card (sandbox is macOS-only). */
  osUnavailable?: boolean;
  /** Docker card enabled only once Settings -> Docker Sandbox is on AND an
   *  image is built - there's nothing for the card to do otherwise. */
  dockerOffered: boolean;
  /** Tooltip shown on the disabled Docker card explaining why. */
  dockerUnavailableReason?: string;
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {CARDS.map(c => {
        const active = engine === c.id;
        const disabled = (c.id === "seatbelt" && osUnavailable) || (c.id === "docker" && !dockerOffered);
        const title = c.id === "seatbelt" && osUnavailable
          ? "Sandbox is macOS-only (requires sandbox-exec)."
          : c.id === "docker" && !dockerOffered
            ? (dockerUnavailableReason ?? "Enable Docker sandbox and build the image in Settings → Docker Sandbox first.")
            : c.desc;
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(c.id)}
            title={title}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
              compact ? "px-3 py-2" : "px-3 py-2.5",
              active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              disabled && "opacity-40 cursor-not-allowed",
            )}
            style={active ? { borderColor: c.color, background: `color-mix(in srgb, ${c.color} 10%, transparent)` } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <c.Icon className="h-4 w-4 shrink-0" style={{ color: c.color }} />
              <span
                className="text-[12px] font-semibold tracking-wide"
                style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}
              >
                {c.label}
              </span>
            </div>
            <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>
              {c.desc}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Shown under the selector when "Docker Container" is the picked engine -
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
