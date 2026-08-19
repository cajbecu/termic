// Daily Docker sandbox image refresh. Opt-out (Settings.docker_daily_rebuild,
// defaults true - see default_true() in lib.rs). Agent CLIs in the image are
// intentionally unpinned (always-latest per Dockerfile.default's own
// comment), which means an image that isn't rebuilt WITHOUT cache can run an
// indefinitely stale binary even though nothing about the Dockerfile itself
// changed. This runs right before a Docker-mode task's agent launches, not
// on a timer - "today" is whenever the user next opens termic and spawns.

import { dockerImageStatus, dockerBuildImage, onDockerBuildDone, settingsLoad } from "./ipc";
import type { Task } from "./types";
import { useUI } from "@/store/ui";

// Single-flight: two Docker-mode tasks launched close together must not
// each kick off their own `docker build --no-cache`, since docker doesn't
// guarantee that's safe run concurrently for the same tag: any request
// received while a rebuild is already running just awaits that promise.
let inFlight: Promise<void> | null = null;

/** Before spawning a Docker-mode agent, rebuild the image if it wasn't
 *  built today and daily rebuild is on. Resolves immediately (no-op) for
 *  anything the feature doesn't apply to: task not in Docker mode, the
 *  global switch off, daily rebuild turned off, no image has EVER been
 *  built (the spawn's own "Docker image not built" error already covers
 *  that), or an image was already built today. Never throws - a failed
 *  rebuild toasts an error and the caller proceeds to spawn with whatever
 *  image already exists. */
export async function maybeRebuildDockerImageForLaunch(task: Task): Promise<void> {
  if (!task.docker_sandbox_enabled) return;

  let settings, status;
  try {
    [settings, status] = await Promise.all([settingsLoad(), dockerImageStatus()]);
  } catch {
    return; // can't tell - don't block launch on a probe failure
  }
  if (!settings.docker_sandbox_enabled) return;
  if (settings.docker_daily_rebuild === false) return;
  if (!status.available || status.built_today) return;

  if (inFlight) return inFlight;
  inFlight = runRebuild().finally(() => { inFlight = null; });
  return inFlight;
}

async function runRebuild(): Promise<void> {
  useUI.getState().pushToast(
    "Termic rebuilds the Docker sandbox image daily to keep agent CLIs current. Rebuilding now before launch (turn off in Settings → Docker)...",
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
    dockerBuildImage(true).catch(() => finish(false));
  });
  if (success) {
    useUI.getState().pushToast("Docker sandbox image rebuilt for today.", "success", { ttlMs: 4000 });
  } else {
    useUI.getState().pushToast(
      "Today's Docker sandbox image rebuild failed - launching with the existing image. Check Settings → Docker.",
      "error",
      { ttlMs: 8000 },
    );
  }
}
