// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@/lib/ipc", () => ({
  settingsLoad: vi.fn(),
  dockerImageStatus: vi.fn(),
  dockerBuildImage: vi.fn(),
  onDockerBuildDone: vi.fn(),
}));

import { maybeRebuildDockerImageForLaunch } from "@/lib/dockerDailyRebuild";
import { settingsLoad, dockerImageStatus, dockerBuildImage, onDockerBuildDone } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import type { Task } from "@/lib/types";

const mockedSettingsLoad = settingsLoad as unknown as ReturnType<typeof vi.fn>;
const mockedImageStatus = dockerImageStatus as unknown as ReturnType<typeof vi.fn>;
const mockedBuildImage = dockerBuildImage as unknown as ReturnType<typeof vi.fn>;
const mockedOnBuildDone = onDockerBuildDone as unknown as ReturnType<typeof vi.fn>;

const baseTask = { id: "t1", docker_sandbox_enabled: true } as unknown as Task;
const baseSettings = { docker_sandbox_enabled: true, docker_daily_rebuild: true };
const baseImage = { available: true, built_today: false };

// Simulates the Rust side emitting docker-build://done right after the
// build IPC call resolves, so runRebuild's promise settles without a
// dangling listener across tests.
function wireBuildDone(success: boolean) {
  mockedOnBuildDone.mockImplementation((cb: (d: { success: boolean }) => void) => {
    queueMicrotask(() => cb({ success }));
    return Promise.resolve(() => {});
  });
}

describe("maybeRebuildDockerImageForLaunch", () => {
  beforeEach(() => {
    mockedSettingsLoad.mockReset();
    mockedImageStatus.mockReset();
    mockedBuildImage.mockReset().mockResolvedValue(undefined);
    mockedOnBuildDone.mockReset();
    useUI.setState({ toasts: [] });
  });

  it("does nothing for a task that isn't in Docker mode", async () => {
    await maybeRebuildDockerImageForLaunch({ ...baseTask, docker_sandbox_enabled: false } as Task);
    expect(mockedSettingsLoad).not.toHaveBeenCalled();
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("does nothing when the global Docker switch is off", async () => {
    mockedSettingsLoad.mockResolvedValue({ ...baseSettings, docker_sandbox_enabled: false });
    mockedImageStatus.mockResolvedValue(baseImage);
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("does nothing when daily rebuild is explicitly turned off (the opt-out)", async () => {
    mockedSettingsLoad.mockResolvedValue({ ...baseSettings, docker_daily_rebuild: false });
    mockedImageStatus.mockResolvedValue(baseImage);
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("treats a missing docker_daily_rebuild field as ON (default-true opt-out)", async () => {
    const { docker_daily_rebuild: _omit, ...settingsWithoutField } = baseSettings;
    mockedSettingsLoad.mockResolvedValue(settingsWithoutField);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).toHaveBeenCalled();
  });

  it("does nothing when no image has ever been built", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue({ available: false, built_today: false });
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("does nothing when the image was already built today", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue({ available: true, built_today: true });
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("rebuilds WITHOUT cache and toasts an explanation when due", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);
    await maybeRebuildDockerImageForLaunch(baseTask);
    // no_cache=true: a cached build would reuse the old `RUN npm install`
    // layers and defeat the entire point of a "daily refresh".
    expect(mockedBuildImage).toHaveBeenCalledWith(true);
    const msgs = useUI.getState().toasts.map(t => t.msg);
    expect(msgs.some(m => /daily/i.test(m) && /rebuild/i.test(m))).toBe(true);
    expect(msgs.some(m => /rebuilt/i.test(m))).toBe(true);
  });

  it("toasts an error and does not throw when the rebuild fails", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(false);
    await expect(maybeRebuildDockerImageForLaunch(baseTask)).resolves.toBeUndefined();
    const [, errorToast] = useUI.getState().toasts;
    expect(errorToast.kind).toBe("error");
  });

  it("does not throw when the settings/status probe itself fails", async () => {
    mockedSettingsLoad.mockRejectedValue(new Error("ipc down"));
    await expect(maybeRebuildDockerImageForLaunch(baseTask)).resolves.toBeUndefined();
    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("single-flights concurrent calls into one build", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);
    await Promise.all([
      maybeRebuildDockerImageForLaunch(baseTask),
      maybeRebuildDockerImageForLaunch({ ...baseTask, id: "t2" } as Task),
    ]);
    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
  });
});
