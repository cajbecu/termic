// Docker sandbox (experimental) — the global, image-level home for the
// Docker cage. Everything per-machine lives here: the master switch, the
// `docker` availability probe, the editable Dockerfile, and the only place
// the image is built or rebuilt. Per-task cage selection lives in the
// task sandbox dialog, not here (one image, many tasks).
//
// Build is deliberately decoupled from spawn: the image is built by an
// explicit action here and never lazily on a PTY spawn (a multi-GB build on
// the spawn path would freeze the webview). See docs/plans/docker-sandbox.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import {
  dockerCheck, dockerImageStatus, dockerGetDockerfile, dockerDefaultDockerfile,
  dockerSetDockerfile, dockerBuildImage, onDockerBuildLog, onDockerBuildDone, dockerAgentDirs,
  settingsSave, dockerCommandPreview,
  type DockerStatus, type DockerImageStatus, type DockerAgentDirs,
  type DockerCommandPreview,
} from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { cn, cleanLines } from "@/lib/utils";
import { formatDockerArgv } from "@/lib/dockerArgv";
import { Loader2, CircleCheck, CircleAlert, ChevronDown, Lock, X, Container } from "lucide-react";

export function DockerSection() {
  const { settings, patch, store } = useBackendSettings();
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [image, setImage] = useState<DockerImageStatus | null>(null);
  const [agentDirs, setAgentDirs] = useState<DockerAgentDirs[]>([]);
  const [showAgentDirs, setShowAgentDirs] = useState(false);
  // Command preview (collapsed by default, same "look it up" treatment as
  // the per-agent dirs above). Rendered by Rust through the SAME
  // build_spec/render_argv the real spawn uses, against a placeholder task,
  // so it can't drift from what actually runs.
  const [showPreview, setShowPreview] = useState(false);
  const [previewAgent, setPreviewAgent] = useState("");
  const [preview, setPreview] = useState<DockerCommandPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Default extra mounts: seeded into a new Docker-sandboxed task's own
  // "Extra mounts" field (Sandbox dialog / New task dialog), same
  // host_path:container_path shape, same explicit dirty/Save pattern as
  // "Global sandbox defaults" (SandboxSection) - a textarea wants an
  // explicit commit, unlike the toggles above which patch on every change.
  const [defaultMounts, setDefaultMounts] = useState("");
  const [defaultMountsOriginal, setDefaultMountsOriginal] = useState("");
  const [mountsBusy, setMountsBusy] = useState(false);
  const mountsHydrated = useRef(false);
  useEffect(() => {
    if (!settings || mountsHydrated.current) return;
    mountsHydrated.current = true;
    const v = (settings.docker_default_extra_mounts ?? []).join("\n");
    setDefaultMounts(v);
    setDefaultMountsOriginal(v);
  }, [settings]);
  const defaultMountsDirty = defaultMounts !== defaultMountsOriginal;
  async function saveDefaultMounts() {
    if (!settings) return;
    setMountsBusy(true);
    try {
      const next: Settings = { ...settings, docker_default_extra_mounts: cleanLines(defaultMounts) };
      await settingsSave(next);
      store(next);
      setDefaultMountsOriginal(defaultMounts);
    } finally { setMountsBusy(false); }
  }

  // Dockerfile editor state.
  // A callback ref backed by STATE, not a plain ref. The editor mounts in an
  // effect that needs the host div to exist, and the whole section lives
  // behind `{enabled && …}`: with Docker off at page load the div does not
  // exist yet, so the effect ran, found no host, and returned - and since it
  // was keyed on `dfLoaded` alone it never ran again once the user enabled
  // Docker and the div appeared. The result was a Dockerfile section with its
  // Save / Reset buttons and no editor at all. Making the host a state value
  // means the effect re-runs the moment it mounts, whatever order that
  // happens in. The new first-run button drives everyone through exactly this
  // path (open the page with Docker off, click enable), so it went from a
  // corner to the default.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const [dockerfile, setDockerfile] = useState("");
  const [savedDockerfile, setSavedDockerfile] = useState("");
  const [dfLoaded, setDfLoaded] = useState(false);
  const [dfBusy, setDfBusy] = useState(false);

  // Build state.
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";
  const editorThemeIdDark = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const themeId = appIsLight ? editorThemeIdLight : editorThemeIdDark;
  const fontSize = usePrefs(s => s.editorFontSize);

  const enabled = !!settings?.docker_sandbox_enabled;
  const dirty = dockerfile !== savedDockerfile;

  // ── Load everything on mount ──────────────────────────────────────
  const refresh = () => {
    dockerCheck().then(setStatus).catch(() => {});
    dockerImageStatus().then(setImage).catch(() => {});
    dockerAgentDirs().then(setAgentDirs).catch(() => {});
  };
  useEffect(() => {
    dockerGetDockerfile()
      .then(df => { setDockerfile(df); setSavedDockerfile(df); })
      .catch(() => {})
      .finally(() => setDfLoaded(true));
    refresh();
  }, []);

  // ── CodeMirror init (once, after the Dockerfile has loaded so the
  // editor is built with its real content in one shot, no throwaway
  // empty-doc instance swapped out a tick later) ──────────────────────
  useEffect(() => {
    if (!dfLoaded || !host || viewRef.current) return;
    let cancelled = false;
    // Dynamic import: @codemirror/legacy-modes is ~150 grammars and this is
    // the only place in the app that wants the Dockerfile one, so it must
    // not join the main chunk (src/lib/languageExts.ts does the same for
    // every legacy-modes grammar; enforced by mainChunkGuard.test.ts).
    import("@codemirror/legacy-modes/mode/dockerfile").then(({ dockerFile }) => {
      if (cancelled || !host || viewRef.current) return;
      const view = new EditorView({
        state: EditorState.create({
          doc: dockerfile,
          extensions: [
            history(),
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
            StreamLanguage.define(dockerFile),
            EditorView.lineWrapping,
            themeComp.current.of([
              resolveEditorTheme(themeId, appIsLight),
              editorSurfaceTheme(fontSize, false),
            ]),
            EditorView.updateListener.of(u => {
              if (u.docChanged) setDockerfile(u.state.doc.toString());
            }),
          ],
        }),
        parent: host,
      });
      viewRef.current = view;
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dfLoaded, host]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure([
        resolveEditorTheme(themeId, appIsLight),
        editorSurfaceTheme(fontSize, false),
      ]),
    });
  }, [themeId, fontSize, appIsLight]);

  // ── Build log streaming ───────────────────────────────────────────
  // Owned by `build()`, which registers these BEFORE invoking the build.
  // This used to be a `[building]` effect, so the listeners only attached
  // after React committed `building: true` and then resolved a promise - a
  // build that failed fast (Dockerfile syntax error, or the daemon stopping
  // between the status probe and the click) emitted `done` before anything
  // was listening, and the button sat on "Building…" over an empty log with
  // no way back. Cleaned up here on unmount.
  const buildUnlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const u of buildUnlistenRef.current) u();
    buildUnlistenRef.current = [];
  }, []);

  // NOT scrollIntoView: it walks every scrollable ancestor to bring the
  // target into view, including the Settings pane itself, so the whole
  // page jittered up and down on every log line (build output streams in
  // several times a second). Scrolling only the log's own container keeps
  // the nudge local to the thing that's actually scrolling.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buildLog]);

  // ── Actions ───────────────────────────────────────────────────────
  async function saveDockerfile() {
    setDfBusy(true);
    try {
      await dockerSetDockerfile(dockerfile);
      setSavedDockerfile(dockerfile);
      refresh();
    } finally { setDfBusy(false); }
  }

  async function resetDockerfile() {
    const def = await dockerDefaultDockerfile();
    setEditorDoc(def);
    setDockerfile(def);
  }

  // Refetch on open and on agent change. Keyed on the agent id (a string),
  // never on an array identity, so an unrelated settings reload can't blank
  // an open panel.
  useEffect(() => {
    if (!showPreview) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewErr(null);
    dockerCommandPreview(undefined, previewAgent || undefined)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(e => { if (!cancelled) { setPreview(null); setPreviewErr(String(e)); } })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [showPreview, previewAgent]);

  function setEditorDoc(text: string) {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }

  // What the single build button should do, from the state it can see.
  // `image.stale` means the Dockerfile's hash no longer matches the built
  // tag; `dirty` means the editor has unsaved edits. Either way a cached
  // build is the right one, because the changed layers are invalidated by the
  // change itself. Only for an image that is current AND unedited does the
  // cached build become pointless, and --no-cache the sole useful action.
  const imageNeedsBuilding = !image?.available || !!image?.stale || dirty;
  const buildNeedsNoCache = !imageNeedsBuilding;
  const buildLabel = !image?.available
    ? "Build image"
    : imageNeedsBuilding
      ? "Rebuild image"
      : "Update agents";

  /** First-run path: flip the switch and start the build in one click. The
   *  setting is persisted BEFORE the build starts, so a build the user
   *  abandons (or that fails) still leaves Docker enabled with the rest of
   *  the page visible, rather than reverting and looking like the click did
   *  nothing. */
  async function enableAndBuild() {
    const ok = await patch({ docker_sandbox_enabled: true });
    if (!ok) return;
    await build(false);
  }

  async function build(noCache: boolean) {
    // Persist any pending edits first so the build matches the editor.
    // Goes through the same dfBusy flag as the explicit Save button so
    // the two can't race and write the Dockerfile out of order.
    if (dirty) {
      setDfBusy(true);
      try { await dockerSetDockerfile(dockerfile); setSavedDockerfile(dockerfile); }
      finally { setDfBusy(false); }
    }
    setBuildLog([]);
    setShowLog(true);
    setBuilding(true);
    // Drop any handles from a previous build, then attach and AWAIT the
    // registration before the build can emit anything.
    for (const u of buildUnlistenRef.current) u();
    buildUnlistenRef.current = [];
    const stop = () => {
      for (const u of buildUnlistenRef.current) u();
      buildUnlistenRef.current = [];
    };
    const unlistenLog = await onDockerBuildLog(line => setBuildLog(l => [...l, line]));
    const unlistenDone = await onDockerBuildDone(({ success }) => {
      setBuilding(false);
      setBuildLog(l => [...l, success ? "✓ Build finished." : "✗ Build failed."]);
      refresh();
      stop();
    });
    buildUnlistenRef.current = [unlistenLog, unlistenDone];
    try {
      await dockerBuildImage(noCache);
    } catch (e) {
      // The invoke itself failed, so no `done` event is coming and nothing
      // would ever clear the spinner.
      setBuilding(false);
      setBuildLog(l => [...l, `✗ ${String(e)}`]);
      stop();
    }
  }

  if (!settings) {
    return <div className="text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title="Docker Sandbox" badge="Experimental" />
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        This isn't a separate set of agents. It's a containerized way of running the SAME agents you configure
        in Settings → Agents &amp; Terminals: an alternative to the Seatbelt sandbox, where the agent runs inside
        a Docker container instead of under macOS sandbox-exec. One image is shared by every Docker task; pick
        Docker per task from its sandbox dialog.
      </p>

      {/* Always-visible FAQ block, not a <details>: the sandbox dialog tried
          collapsing similar material once and users missed what was already
          answered, leading them to re-litigate it in the "Extra" fields (see
          the comment on the removed <details> in TaskSandboxDialog.tsx). The
          two questions people actually ask - "is my login shared?" and "why
          did my agent revert after it updated itself?" - are answered here
          in full rather than hinted at. */}
      <div className="flex flex-col gap-2.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3.5 py-3 text-[12.5px] text-[var(--color-fg-dim)]">
        <div>
          <b className="text-[var(--color-fg)]">Filesystem: </b>
          the agent can only touch what termic mounts (the worktree and its git metadata). Everything else on
          your Mac is invisible to it.
        </div>
        <div>
          <b className="text-[var(--color-fg)]"><u>Network: unrestricted for now</u></b>, unlike Seatbelt's host
          allowlist (a network allow-list for Docker mode is planned once this is stable).
        </div>
        <div>
          <b className="text-[var(--color-fg)]">Logins: </b>
          each agent gets one folder that termic manages on your Mac, reused by every Docker task running that
          agent - log in once and it carries over to your next Docker task with that same agent. Different
          agents don't share a folder with each other, and none of it is your real{" "}
          <code className="font-mono">~/.claude</code>: it is a separate, Docker-only copy.
        </div>
        <div>
          <b className="text-[var(--color-fg)]">Agent updates: </b>
          agent binaries live in the image, not in that mounted folder. If an agent updates itself mid-session,
          the update lives only in that container's own throwaway filesystem - the container is destroyed as
          soon as its terminal closes, so the next launch starts fresh from the image and the self-update is
          gone. Rebuilding the image (below) is what actually picks up newer agent versions; "Rebuild
          frequency" controls how often that is considered due.
        </div>
      </div>

      {/* First run is ONE action, not a toggle plus a hunt. Flipping the
          boolean alone accomplishes nothing visible - the feature stays
          unusable until an image exists, and the button that builds one was
          far below, past four sections the user has no reason to read yet.
          Once an image exists this becomes the ordinary toggle, because from
          then on they really are separate decisions: turning Docker off
          should not throw the image away. */}
      <Block first>
        {!enabled && !image?.available ? (
          <div className="flex flex-col gap-2.5">
            <div>
              <div className="text-[14px] font-medium">Docker sandbox</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                Runs agents inside a container instead of the macOS seatbelt. Needs a one-time image build,
                a few minutes, and Docker running. Existing tasks are unaffected: you pick Docker per task
                afterwards.
              </div>
            </div>
            <div>
              <Button
                variant="primary"
                size="lg"
                disabled={!status?.daemon || building}
                onClick={enableAndBuild}
                data-testid="docker-enable-and-build"
              >
                {building
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Building the image…</>
                  : <><Container className="h-4 w-4" /> Enable Docker sandboxing and build image</>}
              </Button>
              {!status?.binary && (
                <div className="mt-2 text-[12.5px] text-[var(--color-warn)]">
                  Docker isn't installed. Install Docker Desktop, then come back.
                </div>
              )}
              {status?.binary && !status?.daemon && (
                <div className="mt-2 text-[12.5px] text-[var(--color-warn)]">
                  Docker is installed but not running. Start Docker Desktop, then come back.
                </div>
              )}
            </div>
          </div>
        ) : (
          <Toggle
            label="Enable Docker sandbox"
            hint={"While off, no Docker UI appears anywhere and Docker is never invoked. The built image is kept, so turning it back on costs nothing."}
            value={enabled}
            onChange={v => patch({ docker_sandbox_enabled: v })}
          />
        )}
      </Block>

      {enabled && (
        <>
          {/* Both halves of "does this work right now" together: whether Docker is
              reachable, and whether an image exists. The build actions live with the
              image state they act on, instead of at the far end of the page under the
              Dockerfile editor. */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Status</div>
          {/* One block, two columns: both are one-line readouts of the same
              question, and stacking them made a short answer occupy a whole
              screen of vertical space. The build actions stay full width
              underneath, since they act on the image AND need Docker up -
              they belong to the row, not to either column. */}
          <Block>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {/* Image first: it is the one the buttons underneath act on,
                  and the one that changes. Docker's own state is a
                  precondition you check once and then forget. */}
              <div className="min-w-0">
                <div className="text-[14px] font-medium">Image</div>
                <ImageStatusLine image={image} dirty={dirty} />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium">Docker status</div>
                <DockerAvailability status={status} />
              </div>
            </div>
            {/* ONE button, because the two were only ever one real choice.
                "Build image" was a CACHED build and "Update agents" the same
                build with --no-cache; the Dockerfile installs agents unpinned,
                so a cached build of an unchanged Dockerfile replays identical
                layers and updates nothing at all. Two buttons where one is a
                no-op is a question the user has to answer with knowledge of
                Docker's layer cache, which is not knowledge this page should
                require. The state decides instead:

                  no image        build it (cache is empty anyway)
                  Dockerfile edited / stale   rebuild, cache handles the rest
                  current + clean the only useful action is --no-cache, which
                                  is what actually picks up newer agents */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={building || dfBusy || !status?.daemon}
                onClick={() => build(buildNeedsNoCache)}
                title={buildNeedsNoCache
                  ? "Rebuilds from scratch, which is what picks up newer agent versions: the image installs them unpinned, so a cached rebuild would change nothing."
                  : "Builds the image from the Dockerfile, reusing any layers that have not changed."}
              >
                {building
                  ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Building…</span>
                  : buildLabel}
              </Button>
              {!status?.daemon && (
                <span className="text-[12px] text-[var(--color-warn)]">Start Docker to build.</span>
              )}
              {buildLog.length > 0 && (
                <Button variant="ghost" onClick={() => setShowLog(s => !s)}>
                  {showLog ? "Hide log" : "Show log"}
                </Button>
              )}
            </div>
            {showLog && buildLog.length > 0 && (
              <pre
                ref={logRef}
                className="mt-3 max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]"
              >
                {buildLog.join("\n")}
              </pre>
            )}
          </Block>


          {/* Settings that change what a FUTURE task gets. Nothing here acts on the
              running system, which is exactly what separates it from Status above. */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Configuration</div>
          {/* Rebuild nudge frequency. Undefined reads as "daily" (matching
              the Rust-side default) since a fresh settings object may not
              carry the field yet. */}
          <Block>
            <div className="text-[14px] font-medium">Rebuild frequency</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              How often the image is considered out of date. When a Docker-mode agent launches and the image
              has not been rebuilt within this window, termic asks first, or just does it in the background if
              you tick the box below. This is how agent CLIs baked into the image get updated (see "Agent
              updates" above); without it, an old image runs a stale binary indefinitely.
            </div>
            <div className="mt-2 max-w-xs">
              <DockerRebuildFrequencyPicker
                value={settings.docker_rebuild_frequency ?? "daily"}
                onChange={v => patch({ docker_rebuild_frequency: v })}
              />
            </div>
            {/* OUTSIDE the max-w-xs above, which exists to keep the three
                segmented buttons from stretching across the page. A sentence
                nested in it wrapped at 320px into a narrow column while the
                paragraph above ran the full width. */}
            {(settings.docker_rebuild_frequency ?? "daily") !== "off" && (
              <label className="mt-3 flex cursor-pointer items-start gap-2 select-none">
                <Checkbox
                  checked={!!settings.docker_rebuild_auto}
                  onChange={(v: boolean) => patch({ docker_rebuild_auto: v })}
                />
                <span className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                  <span className="font-medium text-[var(--color-fg)]">Rebuild automatically.</span>{" "}
                  Keep the image current on this schedule without asking. The rebuild runs in the
                  background, so agents launch straight away and pick up the new image next time.
                </span>
              </label>
            )}
          </Block>

          {/* Per-agent config dirs: the confirmed built-in list ("Logins"
              above) is read-only - it's what makes login/session sharing
              actually work - plus whatever extra dirs the user wants
              mounted alongside it (a custom skills dir, an extra MCP
              config location, etc). Collapsed by default: this is a
              "look it up when you need it" reference, not something
              every visit to this page needs to see. */}
          <Block>
            <button
              type="button"
              onClick={() => setShowAgentDirs(s => !s)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <div className="text-[14px] font-medium">Persisted directories &amp; environment</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  Directories that survive a container restart, per agent, and the environment it runs with.
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", showAgentDirs && "rotate-180")} />
            </button>
            {showAgentDirs && (
              <div className="mt-3 flex flex-col gap-2">
                {/* "Relative to WHAT?" answered before the list, because a
                    bare `.claude` chip reads like a path on your Mac and is
                    not one: it names a folder inside the agent's HOME in the
                    CONTAINER, backed by a termic-owned folder on the host. */}
                {/* Three facts, one line each. This was five paragraphs
                    that nobody would read: the mechanism, a worked path, a
                    "why /root" aside, a not-your-real-config warning and a
                    chip legend. What a reader needs is the unit (a container
                    path), the concrete example, and the reassurance about
                    `~/.claude`. The rest is in the commit history and the
                    code comments, which is where it belongs. */}
                <div className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                  <div>
                    Kept across container restarts. Each entry is a path{" "}
                    <b className="text-[var(--color-fg)]">inside the container</b>: a bare name means the
                    agent's home there, so <code className="font-mono">.claude</code> is{" "}
                    <code className="font-mono">/root/.claude</code>. Full paths like{" "}
                    <code className="font-mono">/data/models</code> work too.
                  </div>
                  <div>
                    Backed by a folder termic owns, one per agent, never your real{" "}
                    <code className="font-mono">~/.claude</code>. Cloning an agent gets it a separate one,
                    which is how you keep a work login apart from a personal one.
                  </div>
                  <div className="text-[var(--color-fg-faint)]">
                    <code className="font-mono">/root</code> is only where HOME points. The container runs
                    as your own user, with no <code className="font-mono">sudo</code> and no way to elevate.
                  </div>
                </div>

                {agentDirs.map(d => (
                  <AgentDirsRow
                    key={d.agent_id}
                    dirs={d}
                    onChangeExtra={next => {
                      setAgentDirs(cur => cur.map(a => a.agent_id === d.agent_id ? { ...a, extra: next } : a));
                      patch({ docker_agent_extra_dirs: { ...(settings.docker_agent_extra_dirs ?? {}), [d.agent_id]: next } });
                    }}
                    onTogglePersist={next => {
                      setAgentDirs(cur => cur.map(a => a.agent_id === d.agent_id ? { ...a, persist_enabled: next } : a));
                      patch({ docker_agent_persist_enabled: { ...(settings.docker_agent_persist_enabled ?? {}), [d.agent_id]: next } });
                    }}
                    dockerEnv={settings.agents?.find(a => a.id === d.agent_id)?.docker_env ?? {}}
                    onChangeDockerEnv={next => patch({
                      agents: (settings.agents ?? []).map(a =>
                        a.id === d.agent_id ? { ...a, docker_env: next } : a),
                    })}
                  />
                ))}
              </div>
            )}
          </Block>

          {/* Default extra mounts: the Settings-level companion to a
              task's own "Extra mounts" field (Sandbox dialog / New task
              dialog). Same host_path:container_path shape - these are
              UNIONED into a new Docker-sandboxed task's mounts at
              creation, then owned by the task from then on: the user can
              edit, remove, or add to them per task with no effect back
              here. Global rather than per-agent, unlike "Per-agent config
              dirs" above: an extra mount's use case (persisting an MCP
              server's own data dir, say) isn't tied to which agent runs. */}
          <Block>
            <div className="text-[14px] font-medium">Default extra mounts</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              Bind-mount these host directories into every NEW Docker-sandboxed task by default, one per line as{" "}
              <code className="font-mono">host_path:container_path</code> (same field and format as a task's own
              "Extra mounts"). The user can edit, remove, or add to them per task afterward - editing this list only
              affects tasks created from now on.
            </div>
            <div className="mt-3">
              <ListField
                label="Extra mounts"
                placeholder={"$HOME/mcp-data:/data/mcp"}
                value={defaultMounts}
                onChange={setDefaultMounts}
              />
            </div>
            <div className="mt-3">
              <Button variant="primary" disabled={!defaultMountsDirty || mountsBusy} onClick={saveDefaultMounts}>
                {mountsBusy ? "Saving…" : "Save"}
              </Button>
            </div>
          </Block>


          {/* The image definition itself. Last because editing it is rare and the
              shipped default is meant to carry most people. */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Advanced</div>
          {/* Dockerfile editor */}
          <Block>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium">Dockerfile</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  One generic image for all agents. Edit the commented regions to add MCP servers, CLI tools, or
                  baked skills. Personal logins (agent auth, MCP OAuth) are NOT set up here, just run the agent and
                  log in once inside Docker; those persist via your mounted config directory.
                </div>
              </div>
            </div>
            <div
              ref={setHost}
              className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)]"
            />
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" disabled={!dirty || dfBusy || building} onClick={saveDockerfile}>
                {dfBusy ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" disabled={(image?.is_default && !dirty) || dfBusy || building} onClick={resetDockerfile}>
                Reset to default
              </Button>
              {dirty && <span className="text-[12px] text-[var(--color-fg-faint)]">Unsaved edits</span>}
            </div>
          </Block>


          {/* A readout of everything above, so it belongs after it. Mid-page it read
              as another setting rather than the answer to "what will this run". */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Verify</div>
          {/* Command preview. The task sandbox dialog has one per task; this
              is the same thing before any task exists, so "what does the cage
              actually do" is answerable while you are configuring the image
              rather than only after you have switched a task onto it. The
              agent's own command is appended by render_argv, so the last line
              is literally what runs inside the container. */}
          <Block>
            <button
              type="button"
              onClick={() => setShowPreview(s => !s)}
              data-testid="docker-preview-toggle"
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <div className="text-[14px] font-medium">Command preview</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  The exact <code className="font-mono">docker run</code> a task launch builds, agent command included.
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", showPreview && "rotate-180")} />
            </button>
            {showPreview && (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <label className="text-[12.5px] text-[var(--color-fg-dim)]">Agent</label>
                  <select
                    value={previewAgent}
                    onChange={(e) => setPreviewAgent(e.target.value)}
                    data-testid="docker-preview-agent"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                  >
                    <option value="">First enabled agent</option>
                    {agentDirs.map(a => (
                      <option key={a.agent_id} value={a.agent_id}>{a.display_name}</option>
                    ))}
                  </select>
                </div>
                {/* The previous argv stays on screen while the next one
                    loads. Swapping it for a one-line "Loading…" collapsed the
                    panel, the page got shorter, and the browser moved the
                    scroll position - so changing the agent threw the reader
                    somewhere else on the page. Only the very first load has
                    nothing to show, and that one cannot move anything because
                    the panel was closed a moment ago. */}
                <div className="mt-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
                  {previewLoading && !preview && (
                    <div className="text-[12px] text-[var(--color-fg-faint)]">Loading…</div>
                  )}
                  {previewErr && <div className="text-[12px] text-[var(--color-err)]">{previewErr}</div>}
                  {preview && (
                    <div className={cn("transition-opacity", previewLoading && "opacity-50")}>
                      <pre
                        data-testid="docker-preview-argv"
                        className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]"
                      >
                        {formatDockerArgv(preview.argv)}
                      </pre>
                      {!!preview.spec.warnings?.length && (
                        <div className="mt-2 flex flex-col gap-1 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[11.5px] text-[var(--color-fg-dim)]">
                          {preview.spec.warnings!.map((w, i) => <div key={i}>{w}</div>)}
                        </div>
                      )}
                      <div className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[11.5px] text-[var(--color-fg-faint)]">
                        Your task's worktree is mounted in place of the placeholder path above. Everything else,
                        the mounts, the environment and the hardening flags, is what a real launch uses.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Block>

        </>
      )}
    </div>
  );
}

function DockerAvailability({ status }: { status: DockerStatus | null }) {
  if (!status) return <div className="mt-1 text-[12.5px] text-[var(--color-fg-faint)]">Checking…</div>;
  if (!status.binary) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn)]">
        <CircleAlert className="h-3.5 w-3.5" /> `docker` not found on PATH. Install Docker Desktop, OrbStack, or colima.
      </div>
    );
  }
  if (!status.daemon) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn)]">
        <CircleAlert className="h-3.5 w-3.5" /> Docker is installed but the daemon is not running. Start it to build / run.
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
      <CircleCheck className="h-3.5 w-3.5 text-[var(--color-ok)]" /> Ready{status.version ? ` · ${status.version}` : ""}
    </div>
  );
}

function ImageStatusLine({ image, dirty }: { image: DockerImageStatus | null; dirty: boolean }) {
  if (!image) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 text-[12.5px]">
      {image.available ? (
        <span className="flex items-center gap-1.5 text-[var(--color-fg-dim)]">
          <CircleCheck className="h-3.5 w-3.5 text-[var(--color-ok)]" />
          Built · <code className="font-mono">{image.last_built_tag ?? image.current_tag}</code>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[var(--color-fg-faint)]">
          <CircleAlert className="h-3.5 w-3.5" /> Not built yet. Build it to use Docker mode in a task.
        </span>
      )}
      {(image.stale || dirty) && image.available && (
        <span className="flex items-center gap-1.5 text-[var(--color-warn)]">
          <CircleAlert className="h-3.5 w-3.5" />
          Dockerfile edited since the last build. Rebuild to apply your changes (tasks keep using the last built image until then).
        </span>
      )}
      {image.available && !image.stale && !dirty && (
        <span className="flex items-center gap-1.5 text-[var(--color-fg-faint)]">
          {describeLastBuildDate(image.last_built_date)}
        </span>
      )}
    </div>
  );
}

/** One agent's row in "Per-agent config dirs": name, its built-in dirs as
 *  locked chips, its extra dirs as removable chips, and a "+ add" affordance
 *  that becomes a one-line input. For an agent OUTSIDE the known-safe
 *  built-in set, an opt-in "Persist config in Docker mode" checkbox gates
 *  whether `extra` is mounted at all - see docker.rs's `agent_config`. */
/** `KEY=VALUE` lines to a map. Blank lines and `#` comments dropped; a line
 *  with no `=` is ignored rather than becoming an empty-valued key, so a
 *  half-typed line does not silently set something. */
function parseDockerEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function AgentDirsRow({ dirs, onChangeExtra, onTogglePersist, dockerEnv, onChangeDockerEnv }: {
  dirs: DockerAgentDirs;
  onChangeExtra: (next: string[]) => void;
  onTogglePersist: (next: boolean) => void;
  /** The agent's Docker-only environment (`Agent.docker_env`), editable here
   *  as well as in Agents & Terminals: this page is where someone is already
   *  thinking about what a container gets, and a value naming a path on the
   *  Mac is the single most common way to break Docker persistence. */
  dockerEnv: Record<string, string>;
  onChangeDockerEnv: (next: Record<string, string>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const canAdd = dirs.is_builtin || dirs.persist_enabled;

  function commit() {
    const v = draft.trim();
    if (v && !dirs.extra.includes(v)) onChangeExtra([...dirs.extra, v]);
    setDraft("");
    setAdding(false);
  }

  // Two columns of equal height: what is KEPT on the left, what the container
  // RUNS WITH on the right. Stacked, the env box read as an afterthought
  // below the chips and needed a disclosure to stay out of the way; side by
  // side both are answerable at a glance for every agent. `items-stretch` is
  // what makes the textarea match the left column rather than each row
  // setting its own height.
  return (
    <div className="grid grid-cols-2 items-stretch gap-x-4 gap-y-1.5 rounded-md border border-[var(--color-border-soft)] px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[13px] font-medium">{dirs.display_name}</span>
        {dirs.builtin.map(d => (
          <span
            key={d}
            title="Built-in - confirmed to hold real state, can't be removed"
            className="flex items-center gap-1 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]"
          >
            <Lock className="h-2.5 w-2.5 text-[var(--color-fg-faint)]" />
            {d}
          </span>
        ))}
        {dirs.extra.map(d => (
          <span
            key={d}
            className="flex items-center gap-1 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]"
          >
            {d}
            <button
              type="button"
              onClick={() => onChangeExtra(dirs.extra.filter(x => x !== d))}
              aria-label={`Remove ${d}`}
              className="text-[var(--color-fg-faint)] hover:text-[var(--color-err)]"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(""); setAdding(false); }
            }}
            placeholder=".mytool or /data/cache"
            spellCheck={false}
            className="w-24 rounded border border-[var(--color-accent-soft)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg)] outline-none"
          />
        ) : canAdd ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
          >
            + add
          </button>
        ) : null}
      </div>
      {!dirs.is_builtin && dirs.persist_offerable && (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-faint)]">
          <input
            type="checkbox"
            checked={dirs.persist_enabled}
            onChange={e => onTogglePersist(e.target.checked)}
          />
          Persist config in Docker mode
          {dirs.persist_enabled && dirs.extra.length === 0 && (
            <span className="text-[var(--color-warn)]">(add a dir above, nothing is mounted yet)</span>
          )}
        </label>
      )}
      {!dirs.is_builtin && !dirs.persist_offerable && (
        <span className="text-[11px] text-[var(--color-fg-faint)]">
          Not supported in Docker mode: its config and its binary share a location, so mounting anything here
          would risk hiding the binary the image installed.
        </span>
      )}
      </div>

      {/* Right column: the Docker-only environment, always visible. A
          SEPARATE list from the agent's normal one, not a patch on top of
          it - empty means the normal one is used unchanged. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-[11px] text-[var(--color-fg-faint)]">
          Environment (Docker)
          {Object.keys(dockerEnv).length > 0 && (
            <span className="text-[var(--color-fg-dim)]"> · {Object.keys(dockerEnv).length} set</span>
          )}
        </div>
        <textarea
          value={Object.entries(dockerEnv).map(([k, v]) => `${k}=${v}`).join("\n")}
          onChange={e => onChangeDockerEnv(parseDockerEnvLines(e.target.value))}
          rows={2}
          spellCheck={false}
          data-testid={`docker-agent-env-${dirs.agent_id}`}
          placeholder={"KEY=VALUE, one per line\nEmpty = this agent's normal environment"}
          // flex-1 (not field-sizing) so it fills the column and both sides
          // end level, which is the point of the two-column layout.
          className="min-h-[3.25rem] w-full flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 font-mono text-[11.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
    </div>
  );
}
