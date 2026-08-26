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
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import {
  dockerCheck, dockerImageStatus, dockerGetDockerfile, dockerDefaultDockerfile,
  dockerSetDockerfile, dockerBuildImage, onDockerBuildLog, onDockerBuildDone,
  type DockerStatus, type DockerImageStatus,
} from "@/lib/ipc";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { Loader2, CircleCheck, CircleAlert } from "lucide-react";

export function DockerSection() {
  const { settings, patch } = useBackendSettings();
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [image, setImage] = useState<DockerImageStatus | null>(null);

  // Dockerfile editor state.
  const hostRef = useRef<HTMLDivElement>(null);
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
  const logEndRef = useRef<HTMLDivElement>(null);

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
    if (!dfLoaded || !hostRef.current || viewRef.current) return;
    let cancelled = false;
    // Dynamic import: @codemirror/legacy-modes is ~150 grammars and this is
    // the only place in the app that wants the Dockerfile one, so it must
    // not join the main chunk (src/lib/languageExts.ts does the same for
    // every legacy-modes grammar; enforced by mainChunkGuard.test.ts).
    import("@codemirror/legacy-modes/mode/dockerfile").then(({ dockerFile }) => {
      if (cancelled || !hostRef.current || viewRef.current) return;
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
        parent: hostRef.current,
      });
      viewRef.current = view;
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dfLoaded]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure([
        resolveEditorTheme(themeId, appIsLight),
        editorSurfaceTheme(fontSize, false),
      ]),
    });
  }, [themeId, fontSize, appIsLight]);

  // ── Build log streaming ───────────────────────────────────────────
  useEffect(() => {
    if (!building) return;
    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    onDockerBuildLog(line => setBuildLog(l => [...l, line])).then(u => (unlistenLog = u));
    onDockerBuildDone(({ success }) => {
      setBuilding(false);
      setBuildLog(l => [...l, success ? "✓ Build finished." : "✗ Build failed."]);
      refresh();
    }).then(u => (unlistenDone = u));
    return () => { unlistenLog?.(); unlistenDone?.(); };
  }, [building]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ block: "end" }); }, [buildLog]);

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

  function setEditorDoc(text: string) {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
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
    await dockerBuildImage(noCache);
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
        a Docker container instead of under macOS sandbox-exec.
      </p>
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        A filesystem cage: the agent can only touch the folders termic mounts (the worktree and its git
        metadata). Everything else on your Mac is invisible to it. <u>Network access is unrestricted for now</u>,
        unlike Seatbelt's host allowlist (a network allow-list for Docker mode is planned once this is stable).
        One image is shared by every Docker task; pick Docker per task from its sandbox dialog.
      </p>

      {/* Master toggle */}
      <Block first>
        <Toggle
          label="Enable Docker sandbox"
          hint={"While off, no Docker UI appears anywhere and Docker is never invoked. Turn it on, then build the image below. Once built, \"Docker\" becomes selectable in each task's sandbox dialog."}
          value={enabled}
          onChange={v => patch({ docker_sandbox_enabled: v })}
        />
      </Block>

      {enabled && (
        <>
          {/* Rebuild nudge frequency. Undefined reads as "daily" (matching
              the Rust-side default) since a fresh settings object may not
              carry the field yet. */}
          <Block>
            <div className="text-[14px] font-medium">Nudge me to rebuild</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              Before a Docker-mode task's agent launches, if the image hasn't been rebuilt on this schedule,
              termic asks whether to rebuild first (skip is always one click away). Agent CLIs baked into the
              image update constantly; without this an old image can run a stale binary indefinitely.
            </div>
            <div className="mt-2 max-w-xs">
              <DockerRebuildFrequencyPicker
                value={settings.docker_rebuild_frequency ?? "daily"}
                onChange={v => patch({ docker_rebuild_frequency: v })}
              />
            </div>
          </Block>

          {/* Docker availability */}
          <Block>
            <div className="text-[14px] font-medium">Docker status</div>
            <DockerAvailability status={status} />
          </Block>

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
              ref={hostRef}
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

          {/* Image build */}
          <Block>
            <div className="text-[14px] font-medium">Image</div>
            <ImageStatusLine image={image} dirty={dirty} />
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                disabled={building || dfBusy || !status?.daemon}
                onClick={() => build(false)}
              >
                {building ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Building…</span> : "Build image"}
              </Button>
              <Button variant="secondary" disabled={building || dfBusy || !status?.daemon} onClick={() => build(true)}>
                Update agents (rebuild)
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
              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
                {buildLog.join("\n")}
                <div ref={logEndRef} />
              </pre>
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
