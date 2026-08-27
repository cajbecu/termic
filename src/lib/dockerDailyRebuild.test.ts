// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@/lib/ipc", () => ({
  settingsLoad: vi.fn(),
  settingsSave: vi.fn(),
  dockerImageStatus: vi.fn(),
  dockerBuildImage: vi.fn(),
  onDockerBuildDone: vi.fn(),
  // The build log is streamed into the pane now, so the rebuild subscribes
  // to it as well as to `done`. Resolves to an unlisten like the real one.
  onDockerBuildLog: vi.fn(),
}));

import {
  maybeRebuildDockerImageForLaunch,
  isRebuildDue,
  describeLastBuildDate,
} from "@/lib/dockerDailyRebuild";
import { settingsLoad, settingsSave, dockerImageStatus, dockerBuildImage, onDockerBuildDone, onDockerBuildLog } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import type { Task } from "@/lib/types";

const mockedSettingsLoad = settingsLoad as unknown as ReturnType<typeof vi.fn>;
const mockedImageStatus = dockerImageStatus as unknown as ReturnType<typeof vi.fn>;
const mockedBuildImage = dockerBuildImage as unknown as ReturnType<typeof vi.fn>;
const mockedOnBuildDone = onDockerBuildDone as unknown as ReturnType<typeof vi.fn>;

const baseTask = { id: "t1", name: "my-task", docker_sandbox_enabled: true } as unknown as Task;
const baseSettings = { docker_sandbox_enabled: true, docker_rebuild_frequency: "daily" as const };
const baseImage = { available: true, last_built_date: "2000-01-01" }; // ancient - always due

// LOCAL calendar date as YYYY-MM-DD, matching production semantics exactly
// (isRebuildDue / Rust's chrono::Local). `new Date().toISOString()` is UTC
// and disagrees with local "today" for part of every day - using it here
// made this fixture flaky depending on run time/timezone.
function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function wireBuildDone(success: boolean) {
  mockedOnBuildDone.mockImplementation((cb: (d: { success: boolean }) => void) => {
    queueMicrotask(() => cb({ success }));
    return Promise.resolve(() => {});
  });
}

describe("isRebuildDue", () => {
  const now = new Date(2026, 7, 19); // 2026-08-19, local midnight

  it("is always due when nothing has ever been built", () => {
    expect(isRebuildDue("daily", null, now)).toBe(true);
    expect(isRebuildDue("weekly", null, now)).toBe(true);
  });

  it("daily: due the moment the calendar day changes, not due same-day", () => {
    expect(isRebuildDue("daily", "2026-08-19", now)).toBe(false);
    expect(isRebuildDue("daily", "2026-08-18", now)).toBe(true);
  });

  it("weekly: not due until 7 full days have passed", () => {
    expect(isRebuildDue("weekly", "2026-08-13", now)).toBe(false); // 6 days
    expect(isRebuildDue("weekly", "2026-08-12", now)).toBe(true); // 7 days
  });

  it("treats an unparsable date as always due", () => {
    expect(isRebuildDue("daily", "not-a-date", now)).toBe(true);
  });
});

describe("describeLastBuildDate", () => {
  const now = new Date(2026, 7, 19);

  it("covers never-built, today, yesterday, and N days ago", () => {
    expect(describeLastBuildDate(null, now)).toMatch(/never/i);
    expect(describeLastBuildDate("2026-08-19", now)).toMatch(/today/i);
    expect(describeLastBuildDate("2026-08-18", now)).toMatch(/yesterday/i);
    expect(describeLastBuildDate("2026-08-15", now)).toMatch(/4 days ago/i);
  });
});

describe("maybeRebuildDockerImageForLaunch", () => {
  beforeEach(() => {
    mockedSettingsLoad.mockReset();
    mockedImageStatus.mockReset();
    mockedBuildImage.mockReset().mockResolvedValue(undefined);
    mockedOnBuildDone.mockReset();
    // The log listener is registered like the `done` one and its unlisten is
    // called in the finally, so it has to resolve to a function.
    vi.mocked(onDockerBuildLog).mockReset().mockResolvedValue(() => {});
    vi.mocked(settingsSave).mockReset().mockResolvedValue(undefined as never);
    useUI.setState({ toasts: [], dockerRebuildPrompt: null });
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
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });

  it("does nothing when frequency is off (the opt-out)", async () => {
    mockedSettingsLoad.mockResolvedValue({ ...baseSettings, docker_rebuild_frequency: "off" });
    mockedImageStatus.mockResolvedValue(baseImage);
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });

  it("treats a missing docker_rebuild_frequency field as daily (default)", async () => {
    const { docker_rebuild_frequency: _omit, ...settingsWithoutField } = baseSettings;
    mockedSettingsLoad.mockResolvedValue(settingsWithoutField);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);
    const p = maybeRebuildDockerImageForLaunch(baseTask);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    useUI.getState().resolveDockerRebuildPrompt("rebuild");
    await p;
    expect(mockedBuildImage).toHaveBeenCalled();
  });

  it("does nothing when no image has ever been built", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue({ available: false, last_built_date: null });
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });

  it("does nothing when nothing is due yet per the configured frequency", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue({ available: true, last_built_date: localToday() });
    await maybeRebuildDockerImageForLaunch(baseTask);
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });

  it("prompts, then rebuilds WITHOUT cache and toasts when the user picks rebuild", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);

    const p = maybeRebuildDockerImageForLaunch(baseTask);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    expect(useUI.getState().dockerRebuildPrompt?.taskName).toBe("my-task");
    useUI.getState().resolveDockerRebuildPrompt("rebuild");
    await p;

    // no_cache=true: a cached build would reuse the old `RUN npm install`
    // layers and defeat the entire point of a rebuild nudge.
    expect(mockedBuildImage).toHaveBeenCalledWith(true);
    const msgs = useUI.getState().toasts.map(t => t.msg);
    expect(msgs.some(m => /rebuild/i.test(m))).toBe(true);
    expect(msgs.some(m => /rebuilt/i.test(m))).toBe(true);
  });

  it("skips the rebuild entirely when the user picks skip", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);

    const p = maybeRebuildDockerImageForLaunch(baseTask);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    useUI.getState().resolveDockerRebuildPrompt("skip");
    await p;

    expect(mockedBuildImage).not.toHaveBeenCalled();
  });

  it("toasts an error and does not throw when the rebuild fails", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(false);

    const p = maybeRebuildDockerImageForLaunch(baseTask);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    useUI.getState().resolveDockerRebuildPrompt("rebuild");
    await expect(p).resolves.toBeUndefined();

    const [, errorToast] = useUI.getState().toasts;
    expect(errorToast.kind).toBe("error");
  });

  it("does not throw when the settings/status probe itself fails", async () => {
    mockedSettingsLoad.mockRejectedValue(new Error("ipc down"));
    await expect(maybeRebuildDockerImageForLaunch(baseTask)).resolves.toBeUndefined();
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });

  it("single-flights concurrent calls into one prompt/build", async () => {
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue(baseImage);
    wireBuildDone(true);

    const p1 = maybeRebuildDockerImageForLaunch(baseTask);
    const p2 = maybeRebuildDockerImageForLaunch({ ...baseTask, id: "t2" } as Task);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    useUI.getState().resolveDockerRebuildPrompt("rebuild");
    await Promise.all([p1, p2]);

    expect(mockedBuildImage).toHaveBeenCalledTimes(1);
  });
});

describe("describeLastBuildDate at a realistic time of day", () => {
  // The original bug hid behind a midnight `now`: measuring from the current
  // TIME and rounding, an image built today read as "yesterday" from about
  // midday. Every case here uses an afternoon clock on purpose.
  it("calls an image built today 'earlier today' in the afternoon", () => {
    expect(describeLastBuildDate("2026-08-26", new Date(2026, 7, 26, 15, 30)))
      .toBe("It was last built earlier today.");
  });

  it("calls yesterday 'yesterday', not '2 days ago', after 36 hours", () => {
    expect(describeLastBuildDate("2026-08-25", new Date(2026, 7, 26, 15, 30)))
      .toBe("It was last built yesterday.");
  });

  it("counts whole calendar days beyond that", () => {
    expect(describeLastBuildDate("2026-08-22", new Date(2026, 7, 26, 15, 30)))
      .toBe("It was last built 4 days ago.");
  });

  it("agrees with isRebuildDue about what day it is", () => {
    // The two disagreeing is the actual defect: the prompt claimed the image
    // was a day older than the check that decided whether to offer a rebuild.
    const now = new Date(2026, 7, 26, 15, 30);
    expect(describeLastBuildDate("2026-08-26", now)).toBe("It was last built earlier today.");
    expect(isRebuildDue("daily", "2026-08-26", now)).toBe(false);
    expect(describeLastBuildDate("2026-08-25", now)).toBe("It was last built yesterday.");
    expect(isRebuildDue("daily", "2026-08-25", now)).toBe(true);
  });
});

describe("rebuild in background", () => {
  // These describes are SIBLINGS of the main one, so its beforeEach does not
  // reach them: without this the build mock carries call counts across cases
  // and "was not called" silently sees the previous test's calls.
  beforeEach(() => {
    mockedSettingsLoad.mockReset();
    mockedImageStatus.mockReset();
    mockedBuildImage.mockReset().mockResolvedValue(undefined);
    mockedOnBuildDone.mockReset();
    vi.mocked(onDockerBuildLog).mockReset().mockResolvedValue(() => {});
    vi.mocked(settingsSave).mockReset().mockResolvedValue(undefined as never);
    useUI.setState({ toasts: [], dockerRebuildPrompt: null });
  });

  it("starts the build and does NOT make the launch wait for it", async () => {
    // The whole point of the choice: the rebuild exists to stop an agent
    // running a stale binary, but someone who wants to work NOW should not
    // have to pick between that and a several-minute wait.
    mockedSettingsLoad.mockResolvedValue(baseSettings);
    mockedImageStatus.mockResolvedValue({ ...baseImage, last_built_date: "2020-01-01" });
    // A build that never signals `done`. If the launch awaited it, this test
    // would hang rather than fail, which is exactly the bug being prevented.
    vi.mocked(onDockerBuildDone).mockResolvedValue(() => {});
    useUI.setState({ dockerRebuildPrompt: null });

    const launch = maybeRebuildDockerImageForLaunch(baseTask as Task);
    await vi.waitFor(() => expect(useUI.getState().dockerRebuildPrompt).not.toBeNull());
    useUI.getState().resolveDockerRebuildPrompt("background");

    await launch;                                   // resolves without `done`
    expect(mockedBuildImage).toHaveBeenCalledWith(true);   // --no-cache
    expect(useUI.getState().toasts.some(t => /background/i.test(t.msg))).toBe(true);
  });
});

describe("automatic rebuild (the default)", () => {
  // These describes are SIBLINGS of the main one, so its beforeEach does not
  // reach them: without this the build mock carries call counts across cases
  // and "was not called" silently sees the previous test's calls.
  beforeEach(() => {
    mockedSettingsLoad.mockReset();
    mockedImageStatus.mockReset();
    mockedBuildImage.mockReset().mockResolvedValue(undefined);
    mockedOnBuildDone.mockReset();
    vi.mocked(onDockerBuildLog).mockReset().mockResolvedValue(() => {});
    vi.mocked(settingsSave).mockReset().mockResolvedValue(undefined as never);
    useUI.setState({ toasts: [], dockerRebuildPrompt: null });
  });

  it("does not prompt at all, and rebuilds in the background", async () => {
    // `docker_rebuild_auto` ships ON: the image staying current is the whole
    // point, and the background rebuild costs the user nothing because the
    // agent launches immediately either way. Prompting by default meant
    // answering the same question daily to reach the same outcome.
    mockedSettingsLoad.mockResolvedValue({ ...baseSettings, docker_rebuild_auto: true });
    mockedImageStatus.mockResolvedValue({ ...baseImage, last_built_date: "2020-01-01" });
    // Never signals `done`. If automatic ever went back to BLOCKING, this
    // test would hang rather than fail - which is the failure worth catching,
    // since a silent block is exactly what the user opted out of.
    vi.mocked(onDockerBuildDone).mockResolvedValue(() => {});
    useUI.setState({ dockerRebuildPrompt: null, toasts: [] });

    await maybeRebuildDockerImageForLaunch(baseTask as Task);

    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
    expect(mockedBuildImage).toHaveBeenCalledWith(true);
  });

  it("still respects an 'off' frequency", async () => {
    // "off" already means never; automatic must not override an explicit no.
    mockedSettingsLoad.mockResolvedValue({
      ...baseSettings, docker_rebuild_auto: true, docker_rebuild_frequency: "off",
    });
    mockedImageStatus.mockResolvedValue({ ...baseImage, last_built_date: "2020-01-01" });
    await maybeRebuildDockerImageForLaunch(baseTask as Task);
    expect(mockedBuildImage).not.toHaveBeenCalled();
    expect(useUI.getState().dockerRebuildPrompt).toBeNull();
  });
});

