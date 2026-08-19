// Docker sandbox image rebuild nudge, on a user-configurable frequency
// (Settings.docker_rebuild_frequency: off/daily/weekly, defaults daily).
// Agent CLIs in the image are intentionally unpinned (always-latest per
// Dockerfile.default's own comment), which means an image that isn't
// rebuilt WITHOUT cache can run an indefinitely stale binary even though
// nothing about the Dockerfile itself changed. This runs right before a
// Docker-mode task's agent launches, not on a timer - "due" is evaluated
// whenever the user next spawns one. Unlike a silent auto-rebuild, this
// PROMPTS (DockerRebuildPromptDialog) so someone in a hurry can skip it for
// that one launch with a single click.

import { dockerImageStatus, dockerBuildImage, onDockerBuildDone, settingsLoad } from "./ipc";
import type { Task } from "./types";
import { useUI } from "@/store/ui";

export type DockerRebuildFrequency = "off" | "daily" | "weekly";

/** Is a rebuild due, given the configured frequency and the last build's
 *  LOCAL calendar date (`YYYY-MM-DD`, as recorded by the Rust side)? Pure
 *  and exported so the day-boundary math is unit-testable without faking
 *  IPC. `null` (never built) is always due - callers gate on image
 *  availability separately, since "never built" also means "nothing to
 *  launch with" and is handled upstream of this check. */
export function isRebuildDue(frequency: "daily" | "weekly", lastBuiltDateIso: string | null, now: Date = new Date()): boolean {
  if (!lastBuiltDateIso) return true;
  const last = new Date(`${lastBuiltDateIso}T00:00:00`);
  if (Number.isNaN(last.getTime())) return true;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSince = Math.floor((startOfToday.getTime() - last.getTime()) / 86_400_000);
  return frequency === "daily" ? daysSince >= 1 : daysSince >= 7;
}

/** Human-readable "when was this last built" line, shared by Settings →
 *  Docker and the rebuild prompt dialog. */
export function describeLastBuildDate(lastBuiltDateIso: string | null, now: Date = new Date()): string {
  if (!lastBuiltDateIso) return "It has never finished a build.";
  const last = new Date(`${lastBuiltDateIso}T00:00:00`);
  if (Number.isNaN(last.getTime())) return "It has never finished a build.";
  const days = Math.max(0, Math.round((now.getTime() - last.getTime()) / 86_400_000));
  if (days <= 0) return "It was last built earlier today.";
  if (days === 1) return "It was last built yesterday.";
  return `It was last built ${days} days ago.`;
}

// Single-flight: two Docker-mode tasks launched close together must not
// each prompt separately / each kick off their own `docker build
// --no-cache`. A second call while one is already in flight (prompt still
// open, or a build running) just awaits the same outcome - same prompt
// answer applies to both launches.
let inFlight: Promise<void> | null = null;

/** Before spawning a Docker-mode agent, prompt for (and on "rebuild",
 *  await) a rebuild if one is due. Resolves immediately (no-op) for
 *  anything the feature doesn't apply to: task not in Docker mode, the
 *  global switch off, frequency set to "off", no image has EVER been built
 *  (the spawn's own "Docker image not built" error already covers that),
 *  or nothing is due yet per the configured frequency. Never throws - a
 *  skipped or failed rebuild just means the caller proceeds to spawn with
 *  whatever image already exists. */
export async function maybeRebuildDockerImageForLaunch(task: Task): Promise<void> {
  if (!task.docker_sandbox_enabled) return;

  let settings, status;
  try {
    [settings, status] = await Promise.all([settingsLoad(), dockerImageStatus()]);
  } catch {
    return; // can't tell - don't block launch on a probe failure
  }
  if (!settings.docker_sandbox_enabled) return;
  const frequency = settings.docker_rebuild_frequency ?? "daily";
  if (frequency === "off") return;
  if (!status.available) return;
  if (!isRebuildDue(frequency, status.last_built_date)) return;

  if (inFlight) return inFlight;
  inFlight = promptAndRebuild(task, status.last_built_date).finally(() => { inFlight = null; });
  return inFlight;
}

async function promptAndRebuild(task: Task, lastBuiltDate: string | null): Promise<void> {
  const choice = await useUI.getState().askDockerRebuild(task.name, lastBuiltDate);
  if (choice === "skip") return;

  useUI.getState().pushToast(
    "Rebuilding the Docker sandbox image before launch...",
    "info",
    { ttlMs: 15000 },
  );
  const success = await new Promise<boolean>(resolve => {
    let unlisten: (() => void) | undefined;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve(ok);
    };
    onDockerBuildDone(({ success }) => finish(success)).then(u => { unlisten = u; });
    // WITHOUT cache: a cached build would just replay the old `RUN npm
    // install -g ...` layers unchanged and accomplish nothing (same as
    // the manual "Update agents" button - see Dockerfile.default).
    dockerBuildImage(true).catch(() => finish(false));
  });
  if (success) {
    useUI.getState().pushToast("Docker sandbox image rebuilt.", "success", { ttlMs: 4000 });
  } else {
    useUI.getState().pushToast(
      "Docker sandbox image rebuild failed - launching with the existing image. Check Settings → Docker.",
      "error",
      { ttlMs: 8000 },
    );
  }
}
