// CodeMirror 6 editor with syntax highlight. Loads file contents, resolves the
// language (manual pick > path > content sniff, see lib/languages), mounts once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditTab, ScratchTab, Task } from "@/lib/types";
import { EditorState, Compartment, Annotation, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, tooltips } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { search } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { indentUnit } from "@codemirror/language";
import { taskFileRead, taskFileWrite, scratchRead, scratchWrite, scratchSetMeta } from "@/lib/ipc";
import { langForId } from "@/lib/languageExts";
import { effectiveLanguageId, languageIdForPath } from "@/lib/languages";
import { detectSyntaxFromContent } from "@/lib/detectSyntax";
import { attachHiddenScrollRestore } from "@/lib/hiddenScrollRestore";
import { reviewCommentsExtension, dispatchSelectionComment } from "./reviewCommentsExt";
import { inlineBlameExtension, invalidateBlame, refreshBlame, markBlameStale } from "./inlineBlameExt";
import { bindingMatches } from "@/lib/shortcuts";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { deriveScratchTitle } from "@/lib/scratchTitle";

/** How long after the last keystroke a scratchpad's buffer is flushed to the
 *  scratch store and its title re-derived. Both ride the TYPING path, so both
 *  are debounced and both bail when the value is unchanged: writing an
 *  identical title through a store setter copies the whole app state and
 *  re-runs every mounted task's selectors (docs/performance.md bear trap 8). */
const SCRATCH_FLUSH_MS = 500;

/** The syntax to highlight this tab with, sniffing the content when the path
 *  claims nothing (an extension-less file, a `.txt` that is really JSON). The
 *  sniff result is remembered on the tab so the breadcrumb button and the
 *  picker agree with what the buffer actually shows; a manual pick and a
 *  recognised extension both take precedence and skip it entirely. */
function resolveSyntax(taskId: string, tab: EditTab | ScratchTab, content: string): string {
  // A scratchpad has no path at all, so `languageIdForPath` answers null and
  // the content sniffer decides — which is the only thing that CAN decide.
  if (!tab.syntax && !languageIdForPath(tab.type === "edit" ? tab.path : undefined)) {
    const sniffed = detectSyntaxFromContent(content);
    // Bail when unchanged: this runs on every load (and every external
    // reload), and an unconditional write is the store churn docs/performance
    // bear trap 8 is about.
    if (sniffed && sniffed !== tab.syntaxAuto) {
      useApp.getState().patchTab(taskId, tab.id, { syntaxAuto: sniffed });
      return sniffed;
    }
  }
  return effectiveLanguageId(tab);
}

// CodeMirror's search/replace panel inputs (plus any future panel that
// renders text inputs) inherit WKWebView's spellcheck + autocorrect.
// They squiggle every regex, identifier, and non-English token the
// user types. A MutationObserver on the view's DOM strips the attrs
// off any input that appears, including inputs added later when the
// search panel opens. Cheap: one observer per editor instance.
const noAutocorrectOnPanelInputs = ViewPlugin.define(view => {
  const strip = (root: ParentNode) => {
    root.querySelectorAll("input, textarea").forEach(el => {
      const i = el as HTMLInputElement | HTMLTextAreaElement;
      i.spellcheck = false;
      i.setAttribute("autocorrect", "off");
      i.setAttribute("autocapitalize", "off");
      i.setAttribute("autocomplete", "off");
    });
  };
  strip(view.dom);
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (n instanceof HTMLElement) strip(n);
      });
    }
  });
  mo.observe(view.dom, { childList: true, subtree: true });
  return { destroy() { mo.disconnect(); } };
});

// Marks a doc-replacing transaction as an external reload (file changed on
// disk), not a user edit — so the updateListener skips flipping the dirty dot.
const ExternalReload = Annotation.define<boolean>();

/** Scroll the editor to a 1-based line/col and place the cursor there.
 *  Centers the line vertically. Clamps line to the doc bounds so a stale
 *  grep hit on a file that's since shrunk doesn't blow up. */
function revealLine(view: EditorView, line: number, col?: number) {
  const doc = view.state.doc;
  const safe = Math.max(1, Math.min(line, doc.lines));
  const lineObj = doc.line(safe);
  const pos = col && col > 0
    ? Math.min(lineObj.from + col - 1, lineObj.to)
    : lineObj.from;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  // Defer focus to next frame — if the editor isn't visible yet (lazy
  // mount), focus() would no-op silently. requestAnimationFrame gives
  // the layout a tick to settle.
  requestAnimationFrame(() => view.focus());
}

export function EditorPane({ task, tab, active, onContent }: {
  task: Task;
  /** An `edit` tab reads and writes a file in the worktree; a `scratch` tab
   *  (GH #244) reads and writes an untitled buffer in the scratch store and
   *  turns OFF everything that needs a path: inline blame, review comments,
   *  and the changed-on-disk watch. Everything else — the CodeMirror setup,
   *  the theme and language compartments, find, the ⌘S binding — is shared,
   *  because a second editor component would drift from this one inside two
   *  releases. */
  tab: EditTab | ScratchTab;
  /** True when this tab is the active main tab — mirrors TerminalPane's
   *  `active` prop so the editor self-focuses on tab switch, closing, etc. */
  active?: boolean;
  /** Called with the live EditorView on load and after every edit. The
   *  markdown split/preview wrapper uses this to render live without
   *  re-reading disk; it reads `view.state.doc` lazily (inside its own
   *  debounce) so we don't stringify the whole buffer on every keystroke.
   *  Plain editor tabs pass nothing. */
  onContent?: (view: EditorView) => void;
}) {
  const isScratch = tab.type === "scratch";
  // The one string that identifies what this editor is showing. Both the
  // mount effect and every path-keyed extension key off it, so a preview tab
  // recycling to another file and a pad are the same kind of change.
  const srcKey = tab.type === "scratch" ? `scratch:${tab.scratchId}` : tab.path;
  // Empty for a pad. Only ever read on branches guarded by `!isScratch`;
  // it exists so the shared code below does not need a cast per use.
  const filePath = tab.type === "edit" ? tab.path : "";

  const hostRef = useRef<HTMLDivElement>(null);
  // Latest onContent in a ref so the mount effect (which only runs on
  // [task.id, tab.path]) always calls the current callback.
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const viewRef = useRef<EditorView | null>(null);
  const langCompRef = useRef(new Compartment());
  // Which language id the compartment currently holds, so switching syntax
  // (or loading a file) doesn't reconfigure it to what it already is.
  const langIdRef = useRef<string | null>(null);
  // Theme lives in its own compartment so font-size / ligatures changes can be
  // reconfigured live without recreating the entire EditorView.
  const themeCompRef = useRef(new Compartment());
  // Blame lives in its own compartment so the pref (and the palette's toggle)
  // can switch it on and off without rebuilding the view. With it off the
  // extension is not constructed at all, so nothing is fetched, no state
  // field exists, and the editor is byte-for-byte what it was before.
  const blameCompRef = useRef(new Compartment());
  // Which value the compartment currently holds, so the toggle effect can skip
  // the run React fires on mount (the view was just built with this value, and
  // reconfiguring would tear the plugins down and rebuild them for nothing).
  const blameOnRef = useRef<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Mirrors the tab's `dirty` flag so the CodeMirror updateListener
  // only touches the store on the clean→dirty edge, not every
  // keystroke (patchTab re-renders the whole TabBar).
  const dirtyRef = useRef(false);
  // Scratchpad flush state (GH #244). The last content and title actually
  // written, so the debounced flush can bail when nothing changed; the
  // pending timer; and the unmount flush, rebound by every mount.
  const lastFlushedRef = useRef<string | null>(null);
  const lastTitleRef = useRef<string | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const flushScratchRef = useRef<(() => void) | null>(null);

  // Per-task "files changed" tick. Bumped when an agent terminal
  // settles (see app store). We re-read on its rising edge so an open file
  // the agent just rewrote refreshes without a window blur/focus cycle —
  // the common case where the agent runs in the same window the user watches.
  const fsRevision = useApp(s => s.fsRevision[task.id] ?? 0);
  // Bumped by a save here, by the Git panel, and by an agent's commit landing.
  // Blame's answer changes with it.
  const gitRevision = useApp(s => s.gitRevision[task.id] ?? 0);

  // ONE definition of the blame extension, shared by the mount and the toggle
  // effect: two copies of the same `onOpenCommit` would drift.
  const buildBlame = useCallback((enabled: boolean) => enabled && !isScratch
    ? inlineBlameExtension(task.id, filePath, {
        // A `commit:<sha>` diff, the same scope the History panel opens, so it
        // lands somewhere that already knows how to render a historical
        // revision.
        //
        // A REAL tab, not `openPreviewTab`: the preview slot is very likely the
        // file being read (that is where the annotation was hovered), and
        // recycling it would close the file to show its own history. Reuses an
        // identical diff if one is already open rather than stacking duplicates.
        onOpenCommit: sha => {
          const scope = `commit:${sha}` as const;
          const existing = (useApp.getState().tabs[task.id] ?? []).find(
            t => t.type === "diff" && t.path === filePath && t.scope === scope,
          );
          if (existing) {
            useApp.getState().setActiveTabId(task.id, existing.id);
            return;
          }
          useApp.getState().addTab(task.id, {
            id: crypto.randomUUID(),
            type: "diff",
            path: filePath,
            scope,
            title: `\u0394 ${filePath.split("/").pop() || filePath} @ ${sha.slice(0, 7)}`,
          });
        },
      })
    : [], [task.id, filePath, isScratch]);

  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures  = usePrefs(s => s.codeLigatures);
  const inlineBlame    = usePrefs(s => s.inlineBlame);
  // Syntax theme (atomone, tokyo-night, …), independently configurable per
  // app mode (#40): a dark-optimized theme can look wrong on a light app
  // surface, and vice versa. "auto" within each still follows the app
  // palette so a light app never renders dark tokens on a light bg.
  const editorThemeIdDark  = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const themeMode      = usePrefs(s => s.themeMode);
  const appIsLight     = resolveTheme(themeMode) === "light";
  const editorThemeId  = appIsLight ? editorThemeIdLight : editorThemeIdDark;

  // Everything in the theme compartment: the chosen syntax theme plus the
  // surface overrides (font-size / ligatures fold in here too). All
  // reconfigure live — no EditorView rebuild, so cursor + undo survive.
  function buildTheme(sizePx: number, ligatures: boolean, themeId: string): Extension[] {
    return [
      resolveEditorTheme(themeId, appIsLight),
      editorSurfaceTheme(sizePx, ligatures),
    ];
  }

  useEffect(() => {
    let alive = true;
    let detachScrollRestore: (() => void) | null = null;
    // Reset per-load state up front. This effect re-runs when the path
    // changes (preview tabs reuse one instance + swap tab.path), so a
    // stale error from a prior file — e.g. a binary like .DS_Store that
    // failed the UTF-8 read — must be cleared or it renders on top of the
    // next file's content.
    setErr(null);
    setLoading(true);
    (async () => {
      try {
        const content = tab.type === "scratch"
          ? await scratchRead(task.id, tab.scratchId)
          : await taskFileRead(task.id, tab.path);
        if (!alive || !hostRef.current) return;
        blameOnRef.current = usePrefs.getState().inlineBlame;
        langIdRef.current = resolveSyntax(task.id, tab, content);
        const lang = langForId(langIdRef.current);

        // Flip the tab's dirty dot on the first edit after a load/save. A
        // pad is seeded dirty and STAYS dirty for its whole life (nothing has
        // been saved anywhere the user chose), so this is a no-op there after
        // the first call.
        const markDirty = () => {
          if (dirtyRef.current) return;
          dirtyRef.current = true;
          useApp.getState().patchTab(task.id, tab.id, { dirty: true });
        };
        if (tab.type === "scratch") dirtyRef.current = true;
        // ── scratchpad crash safety (GH #244) ──────────────────────────
        // The buffer write and the title derivation both ride the TYPING
        // path, so both are debounced together and both bail when their
        // value is unchanged (docs/performance.md bear trap 8). Neither is
        // "saving": the dirty dot stays on, because nothing has been written
        // anywhere the user chose.
        const flushScratch = (v: EditorView) => {
          if (tab.type !== "scratch") return;
          const text = v.state.doc.toString();
          if (text !== lastFlushedRef.current) {
            lastFlushedRef.current = text;
            scratchWrite(task.id, tab.scratchId, text).catch(() => {});
          }
          // Re-sniff the syntax as the buffer fills. An edit tab resolves
          // this once at mount because its PATH answers, but a pad is always
          // CREATED EMPTY: sniffing only at mount would ask the question at
          // the one moment there is nothing to go on, and the answer would
          // never change however much JSON the user then typed. A manual pick
          // still wins, and an unchanged guess bails.
          const cur0 = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur0?.type === "scratch" && !cur0.syntax) {
            const sniffed = detectSyntaxFromContent(text);
            if (sniffed && sniffed !== cur0.syntaxAuto) {
              useApp.getState().patchTab(task.id, tab.id, { syntaxAuto: sniffed });
            }
          }
          const derived = deriveScratchTitle(text);
          // A double-click rename locks the title, exactly like a renamed
          // terminal tab locks against the agent's OSC titles.
          const cur = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur?.type !== "scratch" || cur.customTitle) return;
          if (derived === lastTitleRef.current || derived === cur.title) {
            lastTitleRef.current = derived;
            return;
          }
          lastTitleRef.current = derived;
          useApp.getState().patchTab(task.id, tab.id, { title: derived });
          scratchSetMeta(task.id, tab.scratchId, { title: derived }).catch(() => {});
        };
        const scheduleScratchFlush = (v: EditorView) => {
          if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = window.setTimeout(() => {
            flushTimerRef.current = null;
            flushScratch(v);
          }, SCRATCH_FLUSH_MS);
        };
        flushScratchRef.current = () => {
          // Unmount flush. ONLY while the pad is still a pad: a Discard-close
          // deletes the record and then unmounts this editor, and re-writing
          // the buffer on the way out would resurrect the note the user just
          // threw away. Promotion changes the tab's type, which is the same
          // check.
          const cur = (useApp.getState().tabs[task.id] ?? []).find(t => t.id === tab.id);
          if (cur?.type !== "scratch") return;
          const v = viewRef.current;
          if (v) flushScratch(v);
        };
        lastFlushedRef.current = content;
        lastTitleRef.current = null;

        // ⌘S → write the buffer to disk. termic NEVER auto-saves; this
        // is the only path that clears `dirty`. Returns true so
        // CodeMirror treats the key as handled and preventDefault's it.
        const saveDoc = (v: EditorView): boolean => {
          // A pad has nowhere to save TO yet. ⌘S opens the promote picker
          // instead of writing to the scratch store: quietly filing the note
          // under `<data_dir>/scratch/` would report success and put it
          // somewhere the user will never look again (GH #244).
          if (tab.type === "scratch") {
            void useUI.getState().askScratchSave(task.id, tab.id);
            return true;
          }
          const name = tab.path.split("/").pop() || tab.path;
          taskFileWrite(task.id, tab.path, v.state.doc.toString())
            .then(() => {
              dirtyRef.current = false;
              useApp.getState().patchTab(task.id, tab.id, { dirty: false });
              useUI.getState().pushToast(`Saved ${name}`, "success");
              // Git-only tick (NOT bumpFsRevision: that would make every
              // open editor — this one included — re-read from disk, and a
              // keystroke landing between the write and that re-read would
              // pop a spurious "changed on disk" banner). Must stay in this
              // .then(): bumped before the write resolves, the status could
              // be computed against the old file.
              useApp.getState().bumpGitRevision(task.id);
              // The file on disk is what `git blame` reads, and it just
              // changed: drop the snapshot and let the extension re-fetch.
              if (usePrefs.getState().inlineBlame) {
                invalidateBlame(task.id, tab.path);
                v.dispatch({ effects: refreshBlame.of() });
              }
            })
            .catch(e => useUI.getState().pushToast(`Save failed: ${e}`, "error"));
          return true;
        };

        const view = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              // ⌘S save — first in the array = highest precedence, so it
              // wins over anything basicSetup's keymaps bind.
              // Tab indents (and Shift-Tab dedents) instead of moving DOM
              // focus to the next button. High precedence so it wins.
              keymap.of([{ key: "Mod-s", preventDefault: true, run: saveDoc }, indentWithTab]),
              // basicSetup: line numbers, fold gutter, history, indentOnInput,
              // bracket matching, close-brackets, autocomplete, active-line +
              // selection-match highlight, and the default/search/history keymaps.
              basicSetup,
              search({ top: true }),
              // CodeMirror's search panel inputs inherit WKWebView's
              // browser defaults (spellcheck + autocorrect ON), which
              // squiggle every regex / identifier / non-English token
              // the user types into Find/Replace. Strip the attrs on
              // any input that appears inside the editor's DOM.
              noAutocorrectOnPanelInputs,
              lintGutter(),
              // Keep every tooltip inside the editor pane. CodeMirror otherwise
              // assumes the whole document viewport is available space, so a
              // card anchored at the end of a long line ran under the right
              // panel, and one near the top ran under the tab bar. Applies to
              // the blame card and the review-comment tooltip alike, which is
              // why it is mounted here rather than inside either extension.
              tooltips({
                tooltipSpace: view => {
                  const r = view.scrollDOM.getBoundingClientRect();
                  const pad = 6;
                  return {
                    left: r.left + pad, top: r.top + pad,
                    right: r.right - pad, bottom: r.bottom - pad,
                  };
                },
              }),
              // Selection → the SAME review-comment surface the diff pane
              // uses (GH #28): select, comment, and it queues in the
              // reviewComments store until the user sends the batch from the
              // pending-comments bar. Deliberately not a one-shot "type an
              // @ref at the agent": half the value of commenting on code is
              // making several remarks and shipping them as one instruction.
              // Comments key off `file`, so an editor comment and a diff
              // comment on the same path land in one list.
              // Caveat vs the diff pane: this buffer is EDITABLE, and stored
              // line numbers do not map through edits. A comment made before
              // heavy typing above it can end up quoting the wrong lines. It
              // is bounded (comments are transient, sent then cleared) and
              // clampLine keeps a stale range in bounds.
              isScratch ? [] : reviewCommentsExtension(task.id, filePath,
                // Quiet surface: no icon chasing the mouse down the gutter, no
                // labelled pill over the selection. One gutter icon, only
                // while something is selected. The diff pane keeps both.
                // `source: "editor"` also drops the "I reviewed your changes"
                // framing from the message: this is code the user is reading,
                // not a review of the agent's work.
                { selection: "gutter", hoverGutter: false, source: "editor" }),
              indentUnit.of("  "),
              EditorState.tabSize.of(2),
              EditorView.updateListener.of(u => {
                if (u.docChanged) {
                  // A programmatic reload (file changed on disk) carries the
                  // ExternalReload annotation — don't treat it as a user edit,
                  // or the tab would sprout a phantom "modified" dot.
                  if (!u.transactions.some(t => t.annotation(ExternalReload)))
                    markDirty();
                  if (isScratch) scheduleScratchFlush(u.view);
                  onContentRef.current?.(u.view);
                }
              }),
              blameCompRef.current.of(buildBlame(blameOnRef.current ?? false)),
              langCompRef.current.of(lang ? [lang] : []),
              themeCompRef.current.of(
                buildTheme(editorFontSize, codeLigatures, editorThemeId),
              ),
            ],
          }),
          parent: hostRef.current,
        });
        viewRef.current = view;
        // E2E-only: expose the CodeMirror view on its DOM node so the
        // WebdriverIO suite can drive real edits/saves through the editor's
        // own API (synthetic key/text events don't route to a contenteditable
        // reliably in WKWebView). Stripped from real builds (VITE_E2E unset).
        if (import.meta.env.VITE_E2E) {
          (view.dom as unknown as { __cmView: EditorView }).__cmView = view;
        }
        // Scroll position dies with the box when a hidden task/tab goes
        // display:none in WKWebView — record and re-apply it.
        detachScrollRestore = attachHiddenScrollRestore(view.scrollDOM);
        setLoading(false);
        // Seed the preview/split wrapper with the live view so it can
        // render before the user makes any edit.
        onContentRef.current?.(view);
        // Initial jump-to-line for Find-in-Files: do it once the view
        // exists. The other useEffect below handles subsequent jumps
        // (clicking a different match while the tab's already open).
        // A pad opens on an empty buffer with the "Untitled" title already
        // set; seed the derivation state so a RESTORED pad whose first line
        // has not changed does not write an identical title back on the first
        // keystroke.
        if (tab.type === "scratch") lastTitleRef.current = deriveScratchTitle(content);
        if (tab.type === "edit" && tab.revealAt) {
          revealLine(view, tab.revealAt.line, tab.revealAt.col);
          useApp.getState().consumeReveal(task.id, tab.id);
        }
      } catch (e) {
        if (!alive) return;
        const msg = String(e);
        // Binary files (.DS_Store, images, compiled blobs) fail the Rust
        // UTF-8 read. Show a human message instead of the raw stream error.
        setErr(/valid UTF-8/i.test(msg)
          ? "This file isn't valid UTF-8 text (it looks binary), so it can't be shown in the editor."
          : msg);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
      // Flush the last <500ms of typing before the view goes away (tab
      // switch, task switch, app teardown). Runs BEFORE destroy(), while the
      // doc is still readable.
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushScratchRef.current?.();
      flushScratchRef.current = null;
      detachScrollRestore?.();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, srcKey]);

  // True-editor tabs surface a "file changed on disk" prompt instead of
  // silently reloading. Pending until the user acts; rendered only while the
  // tab is focused (see the banner in the return).
  const [diskChanged, setDiskChanged] = useState(false);
  // Focused = this task is up front AND this tab is the active main-pane tab
  // (edit/diff tabs only open in the main pane, not in split panes).
  const isActive = useApp(s => s.activeTaskId === task.id && s.activeTab[task.id] === tab.id);

  // Keyboard route to the same composer. A window listener rather than a
  // CodeMirror keymap entry because the binding is user-rebindable (usePrefs).
  // Which editor answers: the one holding DOM focus; when focus is somewhere
  // else entirely (file tree, terminal, nowhere), the visible active tab. That
  // pair is exclusive, so two mounted editors can never both fire on one press.
  const sendRefBinding = usePrefs(s => s.shortcuts["add-selection-to-agent"]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!bindingMatches(e, sendRefBinding)) return;
      const v = viewRef.current;
      if (!v) return;
      const focused = (document.activeElement as HTMLElement | null)?.closest?.(".cm-editor");
      if (focused ? focused !== v.dom : !isActive) return;
      // Nothing selected: let the key fall through untouched.
      if (!dispatchSelectionComment(v)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sendRefBinding, task.id, isActive]);

  // Swap fresh disk content into the live view, annotated so it doesn't flip
  // the dirty dot. Used by both the silent preview-reload path and the user
  // confirming the true-editor prompt.
  const applyDiskContent = useCallback((content: string) => {
    const v = viewRef.current;
    if (!v || isScratch) return;
    if (content !== v.state.doc.toString())
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: content },
        annotations: ExternalReload.of(true),
      });
    // The buffer now matches disk again, so blame can be trusted again. Same
    // reasoning as the save path, and the same reason docs/ideas/lsp.md wants
    // this path to fire a full-document didChange.
    if (usePrefs.getState().inlineBlame) {
      invalidateBlame(task.id, filePath);
      v.dispatch({ effects: refreshBlame.of() });
    }
    setDiskChanged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, filePath, isScratch]);

  // React to an external change (GH #57). An UNTOUCHED buffer (no unsaved
  // edits) just mirrors disk silently — preview tab or not, source or
  // markdown-preview mode; asking about a file the user never modified was
  // noise, and in markdown preview mode the banner lived inside the hidden
  // editor so nothing visibly refreshed at all. Only a DIRTY buffer gets the
  // banner: reloading would discard real typing, so the user decides.
  const reloadFromDisk = useCallback(() => {
    const v = viewRef.current;
    // A pad has no file on disk to diverge from. Nothing outside this editor
    // can touch its buffer, so there is nothing to watch and nothing to ask
    // about (GH #244).
    if (!v || isScratch) return;
    taskFileRead(task.id, filePath).then(content => {
      const v2 = viewRef.current;
      if (!v2) return;
      if (content === v2.state.doc.toString()) { setDiskChanged(false); return; }
      if (dirtyRef.current) { setDiskChanged(true); return; }
      applyDiskContent(content);
    }).catch(() => {});
  }, [task.id, filePath, isScratch, applyDiskContent]);

  // User accepted the prompt: re-read (content may have moved on since the
  // change was detected) and swap it in, discarding the buffer's edits — so
  // the dirty flag must clear too or the dot would lie.
  const acceptDiskReload = useCallback(() => {
    taskFileRead(task.id, filePath).then(content => {
      applyDiskContent(content);
      dirtyRef.current = false;
      useApp.getState().patchTab(task.id, tab.id, { dirty: false });
    }).catch(() => {});
  }, [task.id, filePath, tab.id, applyDiskContent]);

  // Reload on window focus: covers external edits while away (another app,
  // a `git` in a real terminal, an agent in a different window).
  useEffect(() => {
    window.addEventListener("focus", reloadFromDisk);
    return () => window.removeEventListener("focus", reloadFromDisk);
  }, [reloadFromDisk]);

  // Mirror TerminalPane's active-focus pattern: when this tab becomes the
  // active main tab, focus the editor. Belt-and-suspenders alongside
  // focusMainTab() — ensures focus lands even when DOM timing is tricky
  // (split panes, Radix dialogs, visibility toggling).
  useEffect(() => {
    if (!active) return;
    const view = viewRef.current;
    if (!view) return;
    requestAnimationFrame(() => view.focus());
  }, [active]);

  // Reload when an agent terminal in this task settles. Skip the first
  // run (the mount effect already loaded fresh content); thereafter every
  // bump of fsRevision means a turn finished and the file may have changed.
  const fsFirstRef = useRef(true);
  useEffect(() => {
    if (fsFirstRef.current) { fsFirstRef.current = false; return; }
    reloadFromDisk();
  }, [fsRevision, reloadFromDisk]);

  // Subsequent jumps: tab.revealAt changes when the user clicks a new
  // Find-in-Files result for an already-open file. Mount effect above
  // handles the first jump (view doesn't exist yet at that point).
  useEffect(() => {
    const v = viewRef.current;
    const revealAt = tab.type === "edit" ? tab.revealAt : undefined;
    if (!v || !revealAt) return;
    revealLine(v, revealAt.line, revealAt.col);
    useApp.getState().consumeReveal(task.id, tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.type === "edit" ? tab.revealAt : undefined, task.id, tab.id]);

  // Toggling the blame pref reconfigures its compartment in place: no view
  // rebuild, so the cursor, undo history and scroll position all survive.
  useEffect(() => {
    const v = viewRef.current;
    if (!v || blameOnRef.current === inlineBlame) return;
    blameOnRef.current = inlineBlame;
    v.dispatch({ effects: blameCompRef.current.reconfigure(buildBlame(inlineBlame)) });
  }, [inlineBlame, buildBlame]);

  // "Set syntax" (breadcrumb button / command palette) writes `tab.syntax`;
  // the content sniff writes `tab.syntaxAuto`. Either way the language
  // compartment is reconfigured in place — no view rebuild, so the cursor,
  // undo history and scroll position survive changing a file's syntax.
  const syntaxId = effectiveLanguageId(tab);
  useEffect(() => {
    const v = viewRef.current;
    if (!v || langIdRef.current === syntaxId) return;
    langIdRef.current = syntaxId;
    const lang = langForId(syntaxId);
    v.dispatch({ effects: langCompRef.current.reconfigure(lang ? [lang] : []) });
  }, [syntaxId]);

  // A commit landing anywhere (Git panel, or the agent committing in its own
  // terminal) can re-attribute lines this file's snapshot already described.
  // Drop the cache, but only MARK the mounted view stale: this tick also fires
  // for staging and unstaging, and re-blaming eagerly would fork git on every
  // click in the Git panel, per open editor, to redraw one line that usually
  // did not change. The refetch rides the reader's next cursor move.
  useEffect(() => {
    if (gitRevision === 0 || !inlineBlame || isScratch) return;
    invalidateBlame(task.id);
    viewRef.current?.dispatch({ effects: markBlameStale.of() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitRevision, task.id, inlineBlame, isScratch]);

  // Re-apply theme compartment when the user changes font size,
  // ligatures, or the syntax theme — all reconfigure live.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: themeCompRef.current.reconfigure(
        buildTheme(editorFontSize, codeLigatures, editorThemeId),
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorFontSize, codeLigatures, editorThemeId, appIsLight]);

  return (
    // No chrome bar: the tab already shows the filename, and the old
    // Diff / Open buttons were redundant with the Changes panel and the
    // file tree. The editor fills the whole pane. Opaque bg so nothing
    // bleeds through during the load frame (terminals stay mounted
    // underneath via the visibility-toggle keep-alive).
    <div ref={hostRef} className="relative h-full overflow-hidden bg-[var(--color-bg)]">
      {loading && <div className="p-4 text-[14px] text-[var(--color-fg-dim)]">Loading…</div>}
      {err && <div className="p-4 text-[14px] text-[var(--color-err)]">Error: {err}</div>}
      {/* Dirty buffers only: disk diverged while the user has unsaved edits,
          so ask before clobbering (clean buffers reload silently, GH #57). */}
      {diskChanged && isActive && (
        <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 text-[13px] text-[var(--color-fg)] shadow-lg">
          <span>This file changed on disk. Reload discards your edits.</span>
          <button
            onClick={acceptDiskReload}
            className="rounded bg-[var(--color-accent)] px-2 py-[3px] font-medium text-[var(--color-accent-fg)] hover:opacity-90"
          >
            Reload
          </button>
          <button
            onClick={() => setDiskChanged(false)}
            className="rounded px-2 py-[3px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            Keep mine
          </button>
        </div>
      )}
    </div>
  );
}
