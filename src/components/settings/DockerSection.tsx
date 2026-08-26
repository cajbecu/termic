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
  dockerSetDockerfile, dockerBuildImage, onDockerBuildLog, onDockerBuildDone, dockerAgentDirs,
  type DockerStatus, type DockerImageStatus, type DockerAgentDirs,
} from "@/lib/ipc";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { cn } from "@/lib/utils";
import { Loader2, CircleCheck, CircleAlert, ChevronDown, Lock, X } from "lucide-react";

export function DockerSection() {
  const { settings, patch } = useBackendSettings();
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [image, setImage] = useState<DockerImageStatus | null>(null);
  const [agentDirs, setAgentDirs] = useState<DockerAgentDirs[]>([]);
  const [showAgentDirs, setShowAgentDirs] = useState(false);

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
          agents don't share a folder with each other, and none of this is your real <code className="font-mono">~/.claude</code>
          etc: it's a separate, Docker-only copy.
        </div>
        <div>
          <b className="text-[var(--color-fg)]">Agent updates: </b>
          agent binaries live in the image, not in that mounted folder. If an agent updates itself mid-session,
          the update lives only in that container's own throwaway filesystem - the container is destroyed as
          soon as its terminal closes, so the next launch starts fresh from the image and the self-update is
          gone. Rebuilding the image (below) is what actually picks up newer agent versions; "Nudge me to
          rebuild" controls how often termic offers to do that for you before a launch.
        </div>
      </div>

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
              termic asks whether to rebuild first (skip is always one click away). This is how agent CLIs
              baked into the image actually get updated (see "Agent updates" above); without it, an old image
              can run a stale binary indefinitely.
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
                <div className="text-[14px] font-medium">Per-agent config dirs</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  What gets mounted into each agent's shared config folder (see "Logins" above).
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", showAgentDirs && "rotate-180")} />
            </button>
            {showAgentDirs && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="text-[12px] text-[var(--color-fg-faint)]">
                  Locked chips are confirmed to hold real state and can't be removed. Click "+ add" to mount
                  something else there too (a custom skills dir, an extra MCP config location).
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
                  />
                ))}
              </div>
            )}
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
              <pre
                ref={logRef}
                className="mt-3 max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]"
              >
                {buildLog.join("\n")}
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

/** One agent's row in "Per-agent config dirs": name, its built-in dirs as
 *  locked chips, its extra dirs as removable chips, and a "+ add" affordance
 *  that becomes a one-line input. For an agent OUTSIDE the known-safe
 *  built-in set, an opt-in "Persist config in Docker mode" checkbox gates
 *  whether `extra` is mounted at all - see docker.rs's `agent_config`. */
function AgentDirsRow({ dirs, onChangeExtra, onTogglePersist }: {
  dirs: DockerAgentDirs;
  onChangeExtra: (next: string[]) => void;
  onTogglePersist: (next: boolean) => void;
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

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border-soft)] px-3 py-2">
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
              className="text-[var(--color-fg-faint)] hover:text-[var(--color-danger)]"
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
            placeholder=".mytool"
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
  );
}
