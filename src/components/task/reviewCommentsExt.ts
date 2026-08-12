// CodeMirror extension that turns a (read-only) diff/file view into a
// PR-style review surface (GH issue #28): select lines → "Add comment",
// type feedback, and it's held in the reviewComments store until the user
// sends the whole batch to an agent. Committed comments render as cards
// pinned under their range; commented lines get a left accent stripe.
//
// This is framework-free DOM (CodeMirror widgets aren't React). It talks to
// the Zustand store directly for persistence, and pushes store changes back
// into the editor via a StateEffect so cards stay in sync when a comment is
// deleted from the pending-comments bar elsewhere.
//
// Only mounted on the MODIFIED side (unified editor, or the `b` pane of a
// side-by-side MergeView) so line numbers and quotes always refer to the
// new file — which is what an agent needs to act.

import {
  EditorView, WidgetType, Decoration, type DecorationSet, showTooltip, type Tooltip,
  ViewPlugin, type PluginValue, gutter, GutterMarker,
} from "@codemirror/view";
import { StateField, StateEffect, type EditorState, RangeSet, type Range } from "@codemirror/state";
import { useReviewComments, type ReviewComment } from "@/store/reviewComments";
import { sendCommentsToAgent } from "@/lib/sendComments";
import {
  anchorForLines, anchorStateChanged, linesForAnchor, mapAnchor, stateForAnchor, type Anchor,
} from "@/lib/commentAnchors";

/** A comment-in-progress (range + quote captured, body being typed). */
interface Composer {
  mode: "new" | "edit";
  id?: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  initialBody: string;
}

interface CommentData {
  /** Committed comments for THIS file, line-sorted. Synced from the store. */
  comments: ReviewComment[];
  composer: Composer | null;
  /** The live selection each comment was made on, by comment id, mapped
   *  through every edit (see lib/commentAnchors.ts). This — not the stored
   *  line number — is where a comment actually points while the buffer is
   *  being edited under it. File-level comments (null lines) have no anchor. */
  anchors: Map<string, Anchor>;
}

interface Ctx {
  taskId: string;
  file: string;
}

/**
 * How loudly the surface offers to take a comment. The diff pane is a review
 * screen — commenting IS the job there, so it keeps the labelled pill over a
 * selection and a hover button on every line. A code editor is not: you are
 * mostly reading and typing, and a "＋ Comment on lines 12-40" banner following
 * your selection (plus an icon chasing the mouse down the gutter) is a second
 * cursor you did not ask for. There it shrinks to one icon in the gutter,
 * shown only while a selection is standing.
 */
export interface ReviewSurface {
  /** "pill" = labelled button over the selection (diff). "gutter" = a bare
   *  icon on the selection's first line (editor). */
  selection: "pill" | "gutter";
  /** Per-line "＋ comment" button that follows the mouse. Diff only. */
  hoverGutter: boolean;
}

const DIFF_SURFACE: ReviewSurface = { selection: "pill", hoverGutter: true };

const setComments = StateEffect.define<ReviewComment[]>();
const openComposer = StateEffect.define<Composer>();
const closeComposer = StateEffect.define<void>();

const dataField = StateField.define<CommentData>({
  create: () => ({ comments: [], composer: null, anchors: new Map() }),
  update(value, tr) {
    let { comments, composer, anchors } = value;
    // 1. Edits move every held selection. Do this FIRST, so an anchor seeded
    //    in the same transaction (below) is not mapped through changes it was
    //    already built against.
    if (tr.docChanged && anchors.size) {
      const mapped = new Map<string, Anchor>();
      for (const [id, a] of anchors) mapped.set(id, mapAnchor(a, tr.changes));
      anchors = mapped;
    }
    for (const e of tr.effects) {
      if (e.is(setComments)) {
        comments = e.value;
        // The edited comment was deleted out from under us → drop the composer.
        if (composer?.mode === "edit" && !comments.some(c => c.id === composer!.id)) composer = null;
        // Seed an anchor for each comment we have not met yet, and forget the
        // ones whose comment is gone. An id we already track keeps its live
        // anchor: it has been mapped through edits the stored lines predate.
        const next = new Map<string, Anchor>();
        for (const c of comments) {
          if (c.startLine == null) continue;               // file-level: nothing to anchor
          const held = anchors.get(c.id);
          // tr.newDoc, never tr.state: the new state is still being computed
          // inside a field update, and reading it here is re-entrant.
          next.set(c.id, held ?? anchorForLines(tr.newDoc, c.startLine, c.endLine ?? c.startLine));
        }
        anchors = next;
      } else if (e.is(openComposer)) {
        composer = e.value;
      } else if (e.is(closeComposer)) {
        composer = null;
      }
    }
    if (comments === value.comments && composer === value.composer && anchors === value.anchors) {
      return value;
    }
    return { comments, composer, anchors };
  },
});

// Which line the mouse is currently over (1-based), or null. Drives the
// per-line "＋ comment" gutter button (GitHub/PR-style hover affordance).
// Module-level singletons reused by every editor instance — each view keeps
// its own field state, exactly like the comment effects above.
const setHoverLine = StateEffect.define<number | null>();
const hoverLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHoverLine)) value = e.value;
    return value;
  },
});

const clampLine = (state: EditorState, n: number) => Math.max(1, Math.min(state.doc.lines, n));

function locLabel(start: number | null, end: number | null, file: string): string {
  const base = file.split("/").pop() || file;
  if (start == null) return `${base} · whole file`;
  if (end != null && end !== start) return `${base} · lines ${start}–${end}`;
  return `${base} · line ${start}`;
}

// CodeMirror fills its height map (and so lays out the gutter) from each block
// widget's BORDER BOX, so vertical margin on the element `toDOM` returns is
// space it never counts and the gutter drifts further out of step with the code
// on every widget (GH #157). A widget that resizes after being measured goes
// stale the same way, hence the `requestMeasure` in the composer's `autoGrow`.
/** Wrap a block widget so its measured box always equals the space it occupies. */
function blockShell(inner: HTMLElement): HTMLElement {
  const shell = document.createElement("div");
  // flow-root, not block: a block formatting context is what keeps the card's
  // own margins inside the box CodeMirror measures instead of collapsing out.
  shell.style.display = "flow-root";
  shell.appendChild(inner);
  return shell;
}

// lucide `send` — the same glyph the pending-comments bar puts on its Send
// button, so "this goes to the agent now" looks the same everywhere.
const SEND_ICON_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>` +
  `<path d="m21.854 2.147-10.94 10.939"/></svg>`;

// ── Widgets ───────────────────────────────────────────────────────────────

class ComposerWidget extends WidgetType {
  constructor(readonly c: Composer, readonly ctx: Ctx) { super(); }

  eq(other: ComposerWidget) {
    // Same composer identity → reuse the DOM so an unrelated transaction
    // (e.g. a selection change) doesn't blow away a focused textarea.
    return other.c.mode === this.c.mode
      && other.c.id === this.c.id
      && other.c.startLine === this.c.startLine
      && other.c.endLine === this.c.endLine;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "tc-comment-composer";

    const head = document.createElement("div");
    head.className = "tc-comment-loc";
    head.textContent = locLabel(this.c.startLine, this.c.endLine, this.ctx.file);
    wrap.appendChild(head);

    const ta = document.createElement("textarea");
    ta.className = "tc-comment-textarea";
    ta.placeholder = "Add a comment";
    ta.value = this.c.initialBody;
    // Rough starting height (no layout yet, so `scrollHeight` is 0 here) to
    // keep an edit composer from mounting at one line and popping open a frame
    // later; `autoGrow` corrects for wrapping once it is in the document.
    ta.rows = Math.min(this.c.initialBody.split("\n").length, 8);
    ta.spellcheck = false;
    ta.autocapitalize = "off";
    ta.setAttribute("autocorrect", "off");
    wrap.appendChild(ta);

    // Grow with content (Shift+Enter newlines) up to a cap. The grow happens
    // after CodeMirror measured the widget, so re-sync the height map or the
    // gutter drifts (see `blockShell`); CodeMirror coalesces these per frame.
    const autoGrow = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
      view.requestMeasure();
    };
    ta.addEventListener("input", autoGrow);

    const row = document.createElement("div");
    row.className = "tc-comment-actions";

    const hint = document.createElement("span");
    hint.className = "tc-comment-hint";
    hint.textContent = "↵ to send · ⇧↵ for newline";
    row.appendChild(hint);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tc-btn tc-btn-ghost tc-btn-cancel";
    cancel.textContent = "Cancel";
    row.appendChild(cancel);

    // Two ways out, because a remark on code is sometimes the whole thought
    // and sometimes one of five. "Add to pending" queues it with the rest;
    // "Send" (the accent CTA) ships this one immediately, and the comment body
    // is OPTIONAL there — the selected code alone is a legitimate message.
    // Editing an existing queued comment offers Update only: it is already in
    // the queue, and the bar is where a queue gets sent.
    const editing = this.c.mode === "edit" && !!this.c.id;

    const queue = document.createElement("button");
    queue.type = "button";
    queue.className = "tc-btn tc-btn-ghost tc-btn-queue";
    queue.textContent = editing ? "Update" : "Add to pending";
    row.appendChild(queue);

    const send = document.createElement("button");
    send.type = "button";
    send.className = "tc-btn tc-btn-primary tc-btn-send";
    send.innerHTML = `${SEND_ICON_SVG}<span>Send</span>`;
    send.title = "Send this selection to the agent now";
    if (!editing) row.appendChild(send);

    wrap.appendChild(row);

    /** The comment as it stands, whether or not it was ever queued. */
    const draft = (body: string): ReviewComment => ({
      id: this.c.id ?? "draft",
      taskId: this.ctx.taskId,
      file: this.ctx.file,
      startLine: this.c.startLine,
      endLine: this.c.endLine,
      quote: this.c.quote,
      body,
    });

    const commit = () => {
      const body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      const store = useReviewComments.getState();
      if (editing && this.c.id) {
        store.update(this.ctx.taskId, this.c.id, body);
      } else {
        store.add({
          taskId: this.ctx.taskId,
          file: this.ctx.file,
          startLine: this.c.startLine,
          endLine: this.c.endLine,
          quote: this.c.quote,
          body,
        });
      }
      view.dispatch({ effects: closeComposer.of() });
      view.focus();
    };

    const sendNow = () => {
      void sendCommentsToAgent(this.ctx.taskId, [draft(ta.value.trim())], {
        label: locLabel(this.c.startLine, this.c.endLine, this.ctx.file),
      });
      // Close, but do NOT take focus back: the send hands the stage to the
      // agent (switches to its tab, focuses its terminal), and an editor
      // grabbing focus a beat before that lands would fight it.
      view.dispatch({ effects: closeComposer.of() });
    };
    const cancelFn = () => {
      view.dispatch({ effects: closeComposer.of() });
      view.focus();
    };

    queue.addEventListener("click", commit);
    send.addEventListener("click", sendNow);
    cancel.addEventListener("click", cancelFn);
    ta.addEventListener("keydown", (e) => {
      // Enter takes the accent action (send now), Shift+Enter inserts a
      // newline — chat-composer muscle memory, and the CTA is what Enter
      // should mean. Editing a queued comment has no send button, so there
      // Enter still updates it in place.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (editing) commit(); else sendNow();
      }
      else if (e.key === "Escape") { e.preventDefault(); cancelFn(); }
      e.stopPropagation(); // keep keystrokes out of CodeMirror's keymap
    });

    setTimeout(() => {
      // The composer can mount outside the visible viewport — a file-level
      // comment anchors at doc start (pos 0), which is scrolled away whenever
      // the user is deep in the diff. Reveal it before focusing: focus() on
      // an off-screen child of the CM scroller does not scroll it in.
      wrap.scrollIntoView({ block: "nearest" });
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autoGrow();
    }, 0);
    return blockShell(wrap);
  }

  ignoreEvent() { return true; }
}

class CommentCardWidget extends WidgetType {
  constructor(readonly comment: ReviewComment, readonly ctx: Ctx) { super(); }

  eq(other: CommentCardWidget) {
    // The RANGE is part of what the card renders (its "· line 12" label), and
    // ranges move now that comments are anchored to their code rather than to
    // a line number. Comparing id + body alone kept a stale label on screen
    // after an edit shifted the comment.
    return other.comment.id === this.comment.id
      && other.comment.body === this.comment.body
      && other.comment.startLine === this.comment.startLine
      && other.comment.endLine === this.comment.endLine;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "tc-comment-card";

    const head = document.createElement("div");
    head.className = "tc-comment-card-head";

    const loc = document.createElement("span");
    loc.className = "tc-comment-loc";
    loc.textContent = locLabel(this.comment.startLine, this.comment.endLine, this.ctx.file);
    head.appendChild(loc);

    const tools = document.createElement("div");
    tools.className = "tc-comment-tools";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "tc-icon-btn";
    edit.title = "Edit comment";
    edit.textContent = "Edit";
    tools.appendChild(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "tc-icon-btn tc-icon-btn-danger";
    del.title = "Delete comment";
    del.textContent = "Delete";
    tools.appendChild(del);

    head.appendChild(tools);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "tc-comment-body";
    body.textContent = this.comment.body;
    wrap.appendChild(body);

    edit.addEventListener("click", () => {
      view.dispatch({
        effects: openComposer.of({
          mode: "edit",
          id: this.comment.id,
          startLine: this.comment.startLine,
          endLine: this.comment.endLine,
          quote: this.comment.quote,
          initialBody: this.comment.body,
        }),
      });
    });
    del.addEventListener("click", () => {
      useReviewComments.getState().remove(this.ctx.taskId, this.comment.id);
    });

    return blockShell(wrap);
  }

  ignoreEvent() { return true; }
}

// ── Decorations ─────────────────────────────────────────────────────────────

function buildDeco(state: EditorState, ctx: Ctx): DecorationSet {
  const { comments, composer, anchors } = state.field(dataField);
  const ranges: Range<Decoration>[] = [];
  // Where a comment sits RIGHT NOW: its mapped anchor while we hold one (the
  // store's line numbers lag by a keystroke), else the stored lines.
  const linesOf = (c: ReviewComment): { start: number; end: number } | null => {
    if (c.startLine == null || c.endLine == null) return null;
    const a = anchors.get(c.id);
    if (!a) return { start: clampLine(state, c.startLine), end: clampLine(state, c.endLine) };
    const { startLine, endLine } = linesForAnchor(state.doc, a);
    return { start: startLine, end: endLine };
  };

  // Accent stripe on every committed-comment line.
  for (const c of comments) {
    const ln = linesOf(c);
    if (!ln) continue;
    for (let i = ln.start; i <= ln.end; i++) {
      ranges.push(Decoration.line({ class: "tc-commented-line" }).range(state.doc.line(i).from));
    }
  }

  // Committed comment cards (skip the one currently being edited).
  for (const c of comments) {
    if (composer?.mode === "edit" && composer.id === c.id) continue;
    const anchor = linesOf(c)?.end ?? null;
    const pos = anchor == null ? 0 : state.doc.line(anchor).to;
    ranges.push(
      Decoration.widget({ widget: new CommentCardWidget(c, ctx), block: true, side: anchor == null ? -1 : 1 }).range(pos),
    );
  }

  // Active composer.
  if (composer) {
    const anchor = composer.endLine == null ? null : clampLine(state, composer.endLine);
    const pos = anchor == null ? 0 : state.doc.line(anchor).to;
    ranges.push(
      Decoration.widget({ widget: new ComposerWidget(composer, ctx), block: true, side: anchor == null ? -1 : 2 }).range(pos),
    );
  }

  return ranges.length ? RangeSet.of(ranges, true) : Decoration.none;
}

// ── Selection tooltip: "Add comment" ────────────────────────────────────────

function commentTooltips(state: EditorState, surface: ReviewSurface): readonly Tooltip[] {
  if (surface.selection !== "pill") return [];
  const range = state.selection.main;
  if (range.empty) return [];
  const startLine = state.doc.lineAt(range.from).number;
  const endLine = state.doc.lineAt(range.to).number;
  return [{
    pos: range.from,
    above: true,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "tc-add-comment-tip";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tc-add-comment-btn";
      btn.textContent = endLine > startLine
        ? `＋ Comment on lines ${startLine}–${endLine}`
        : `＋ Comment on line ${startLine}`;
      // mousedown + preventDefault so the editor doesn't clear the selection
      // before we read it.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        dispatchSelectionComment(view);
      });
      dom.appendChild(btn);
      return { dom };
    },
  }];
}

// ── Store subscription plugin ────────────────────────────────────────────────

function commentsForFile(taskId: string, file: string): ReviewComment[] {
  const all = useReviewComments.getState().byTask[taskId] ?? [];
  return all
    .filter((c) => c.file === file)
    .slice()
    // Sort by line, then by id as a stable tiebreaker so comments sharing a
    // line (or both file-level) keep a deterministic order — otherwise the
    // dedup signature could flip and force needless decoration rebuilds.
    .sort((a, b) => (a.startLine ?? -1) - (b.startLine ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function storeSyncPlugin(ctx: Ctx) {
  return ViewPlugin.define((view): PluginValue => {
    // The store fires on EVERY mutation app-wide (any task/file), and
    // DiffPane keeps views alive across tab switches + can mount two views
    // for the same file (main + right split). So two guards:
    //   1. `destroyed` — the seed microtask and late subscription callbacks
    //      must never dispatch into a view torn down by a rebuild/tab switch
    //      (CodeMirror throws on dispatch-after-destroy).
    //   2. `lastSig` — only dispatch when THIS file's comments actually
    //      changed, so an edit on an unrelated file doesn't rebuild our
    //      decorations (and selection-only transactions keep the cheap
    //      decoField map path).
    let destroyed = false;
    let lastSig: string | null = null;
    const push = () => {
      if (destroyed) return;
      const list = commentsForFile(ctx.taskId, ctx.file);
      // JSON-encode so a free-form body (spaces, colons, newlines) can't
      // collide with another comment's serialization and suppress an update.
      const sig = JSON.stringify(list.map(c => [c.id, c.startLine, c.endLine, c.body]));
      if (sig === lastSig) return;
      lastSig = sig;
      view.dispatch({ effects: setComments.of(list) });
    };
    const unsub = useReviewComments.subscribe(push);
    // Seed (the store may already hold comments for this file, e.g. when the
    // diff tab is re-opened). Defer so the field is installed first.
    queueMicrotask(push);
    return { destroy() { destroyed = true; unsub(); } };
  });
}

/**
 * Push the mapped anchors back onto the stored comments.
 *
 * The editor holds the truth while it is open, but the two things that consume
 * a comment — the pending-comments bar and the message the batch sends — read
 * the store, and one of them runs with no editor mounted at all. So after the
 * doc settles, re-derive each comment's line range + quote from its anchor and
 * write back the ones that actually moved.
 *
 * Debounced rather than per-keystroke: mapping is cheap, a store write is not
 * (it re-renders the bar and rebuilds this view's decorations through
 * storeSyncPlugin). Typing inside a commented range would otherwise churn both
 * on every character.
 */
const REANCHOR_DEBOUNCE_MS = 300;

function anchorSyncPlugin(ctx: Ctx) {
  return ViewPlugin.define((view): PluginValue => {
    let timer = 0;
    let destroyed = false;
    const flush = () => {
      const { comments, anchors } = view.state.field(dataField);
      const store = useReviewComments.getState();
      for (const c of comments) {
        const a = anchors.get(c.id);
        if (!a) continue;
        const next = stateForAnchor(view.state.doc, a);
        if (anchorStateChanged(c, next)) store.reanchor(ctx.taskId, c.id, next);
      }
    };
    return {
      update(u) {
        if (!u.docChanged) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { if (!destroyed) flush(); }, REANCHOR_DEBOUNCE_MS);
      },
      destroy() {
        destroyed = true;
        window.clearTimeout(timer);
        // Leaving the file (tab switch, task switch, a rebuild on theme change)
        // must not drop what the debounce was still holding: flush on the way
        // out, while `view.state` is still readable.
        flush();
      },
    };
  });
}

// ── Per-line hover gutter: "＋ comment on this line" ─────────────────────────

// lucide `message-square-plus`, inlined (widgets are framework-free DOM).
const COMMENT_ICON_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>` +
  `<path d="M12 8v6"/><path d="M9 11h6"/></svg>`;

class AddCommentGutterMarker extends GutterMarker {
  constructor(readonly ctx: Ctx, readonly lineNo: number, readonly wholeSelection = false) { super(); }

  eq(other: AddCommentGutterMarker) {
    return other.lineNo === this.lineNo && other.wholeSelection === this.wholeSelection;
  }

  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    // One control, one look, both surfaces: the editor's selection button is
    // the diff's line button (accent chip and all). Only what it targets and
    // what it is called differ.
    btn.className = "tc-line-add-btn";
    // The editor's icon is the entry point to "mark this code up for the
    // agent", so it says what the gesture is FOR, not what it mechanically
    // does. The diff's per-line button keeps its own wording.
    btn.title = this.wholeSelection ? "Send selection to agent" : "Comment on this line";
    btn.innerHTML = COMMENT_ICON_SVG;
    // mousedown + preventDefault so the click doesn't move the editor
    // selection (and dismiss us) before we read the line.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (this.wholeSelection && dispatchSelectionComment(view)) return;
      const s = clampLine(view.state, this.lineNo);
      const line = view.state.doc.line(s);
      view.dispatch({
        selection: { anchor: line.from },
        effects: openComposer.of({ mode: "new", startLine: s, endLine: s, quote: line.text, initialBody: "" }),
      });
    });
    return btn;
  }
}

/** The line the gutter button belongs on: the hovered one where hovering is
 *  offered, otherwise the first line of a standing selection. Null when there
 *  is nothing to offer. */
function gutterLine(state: EditorState, surface: ReviewSurface): number | null {
  if (surface.hoverGutter) {
    const hovered = state.field(hoverLineField);
    if (hovered != null) return hovered;
  }
  if (surface.selection !== "gutter") return null;
  const range = state.selection.main;
  return range.empty ? null : state.doc.lineAt(range.from).number;
}

/** Gutter that shows a comment button on one line (see `gutterLine`). */
function commentGutter(ctx: Ctx, surface: ReviewSurface) {
  return gutter({
    class: "tc-comment-gutter",
    lineMarker(view, block) {
      const target = gutterLine(view.state, surface);
      if (target == null) return null;
      const lineNo = view.state.doc.lineAt(block.from).number;
      // In selection mode the button commits the WHOLE selection, not just the
      // line it sits on — it is an affordance for what is already highlighted.
      return lineNo === target
        ? new AddCommentGutterMarker(ctx, lineNo, surface.selection === "gutter")
        : null;
    },
    // Only recompute markers when what drives them changes, not on every
    // scroll or doc transaction.
    lineMarkerChange(update) {
      if (surface.hoverGutter
        && update.startState.field(hoverLineField) !== update.state.field(hoverLineField)) return true;
      return surface.selection === "gutter" && !!update.selectionSet;
    },
  });
}

/** Tracks the hovered line and pushes it into `hoverLineField`. Dispatches
 *  only when the line actually changes (coalesced to one rAF per frame) so a
 *  fast mouse sweep doesn't flood the editor with transactions. */
function hoverTrackPlugin() {
  return ViewPlugin.define((view): PluginValue => {
    let current: number | null = null;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const apply = () => {
      raf = 0;
      if (!pending) return;
      const pos = view.posAtCoords(pending);
      const ln = pos == null ? null : view.state.doc.lineAt(pos).number;
      if (ln === current) return;
      current = ln;
      view.dispatch({ effects: setHoverLine.of(ln) });
    };
    const onMove = (e: MouseEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      pending = null;
      if (current !== null) { current = null; view.dispatch({ effects: setHoverLine.of(null) }); }
    };
    view.scrollDOM.addEventListener("mousemove", onMove);
    view.scrollDOM.addEventListener("mouseleave", onLeave);
    return {
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        view.scrollDOM.removeEventListener("mousemove", onMove);
        view.scrollDOM.removeEventListener("mouseleave", onLeave);
      },
    };
  });
}

// ── Public extension factory ─────────────────────────────────────────────────

/** Build the review-comments extension for one file in one task. `surface`
 *  defaults to the diff pane's loud affordances; editors pass the quiet set. */
export function reviewCommentsExtension(taskId: string, file: string, surface: ReviewSurface = DIFF_SURFACE) {
  const ctx: Ctx = { taskId, file };

  const decoField = StateField.define<DecorationSet>({
    create: (state) => buildDeco(state, ctx),
    update(deco, tr) {
      const before = tr.startState.field(dataField);
      const after = tr.state.field(dataField);
      if (before === after && !tr.docChanged) return deco.map(tr.changes);
      return buildDeco(tr.state, ctx);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const tooltipField = StateField.define<readonly Tooltip[]>({
    create: (state) => commentTooltips(state, surface),
    update(tips, tr) {
      if (!tr.docChanged && !tr.selection) return tips;
      return commentTooltips(tr.state, surface);
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  return [
    dataField,
    hoverLineField,
    decoField,
    tooltipField,
    commentGutter(ctx, surface),
    ...(surface.hoverGutter ? [hoverTrackPlugin()] : []),
    // A gutter costs its width on every line, forever, and an editor is read
    // far more than it is commented on. Where the button is selection-driven
    // (no hover to anticipate), collapse the column to nothing until there IS
    // something to put in it — otherwise every file, markdown included, pays
    // 20px of horizontal room and starts scrolling sideways sooner than it
    // used to. The diff pane keeps a fixed column: it always shows a button on
    // hover, so a width that appears and disappears under the mouse would be
    // worse than the space.
    ...(surface.hoverGutter ? [] : [
      EditorView.editorAttributes.compute([dataField, "selection"], (state) => ({
        class: gutterLine(state, surface) != null || state.field(dataField).comments.length
          ? "tc-gutter-live" : "tc-gutter-idle",
      })),
    ]),
    storeSyncPlugin(ctx),
    anchorSyncPlugin(ctx),
    baseTheme,
  ];
}

/**
 * Open the composer on the current selection — the tooltip button's action,
 * also reachable from the keyboard (EditorPane's "add selection to agent"
 * shortcut). Returns false when nothing is selected, so a key binding can fall
 * through instead of swallowing the chord.
 */
export function dispatchSelectionComment(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (range.empty) return false;
  // Clamp against the LIVE doc: the selection may reference a line the file no
  // longer has (an agent rewrote it under an open editor).
  const last = view.state.doc.lines;
  const s = Math.max(1, Math.min(view.state.doc.lineAt(range.from).number, last));
  const en = Math.max(s, Math.min(view.state.doc.lineAt(range.to).number, last));
  const quote = view.state.sliceDoc(view.state.doc.line(s).from, view.state.doc.line(en).to);
  view.dispatch({
    // Collapse the selection so the tooltip dismisses, then open the composer.
    selection: { anchor: view.state.doc.line(s).from },
    effects: openComposer.of({ mode: "new", startLine: s, endLine: en, quote, initialBody: "" }),
  });
  return true;
}

/** Open a whole-file comment composer programmatically (DiffPane header). */
export function dispatchFileComment(view: EditorView) {
  view.dispatch({
    effects: [
      openComposer.of({ mode: "new", startLine: null, endLine: null, quote: "", initialBody: "" }),
      // The composer anchors at doc start; when the user is scrolled down,
      // pos 0 is outside CM's rendered viewport, so the widget's DOM never
      // even mounts (no toDOM → no self-focus). Scroll there in the same
      // transaction so the composer materializes and its focus can land.
      EditorView.scrollIntoView(0),
    ],
  });
}

// ── Styling (self-contained; only CSS vars, no hard-coded hex) ───────────────

const baseTheme = EditorView.baseTheme({
  ".tc-commented-line": {
    backgroundColor: "var(--color-accent-soft)",
    boxShadow: "inset 2px 0 0 0 var(--color-accent)",
  },
  ".tc-add-comment-tip": { background: "transparent", border: "none" },
  ".tc-add-comment-btn": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 9px",
    borderRadius: "7px",
    fontSize: "12px",
    fontWeight: "500",
    lineHeight: "1",
    cursor: "pointer",
    color: "var(--color-accent-fg)",
    background: "var(--color-accent)",
    border: "1px solid var(--color-accent-deep)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
    whiteSpace: "nowrap",
  },
  // Hover drops to accent-deep, which is dark in every theme, so the ink
  // goes back to white (accent-fg would be dark-on-dark on rosepine).
  ".tc-add-comment-btn:hover": { background: "var(--color-accent-deep)", color: "#fff" },
  // Inline thread cards: an accent left rail ties them to the commented-line
  // stripe, a flat fill (no popover shadow) so they read as part of the diff,
  // not floating over it. Vertical spacing belongs HERE, inside `blockShell`,
  // never on the shell itself (GH #157).
  ".tc-comment-card, .tc-comment-composer": {
    margin: "3px 14px 9px 14px",
    padding: "8px 11px 9px",
    borderRadius: "8px",
    border: "1px solid var(--color-border-soft)",
    borderLeft: "2.5px solid var(--color-accent)",
    background: "var(--color-bg-2)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  ".tc-comment-composer": { background: "var(--color-bg-1)" },
  ".tc-comment-loc": {
    display: "inline-flex",
    alignItems: "center",
    fontSize: "10.5px",
    fontWeight: "600",
    letterSpacing: "0.01em",
    color: "var(--color-fg-faint)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  ".tc-comment-card-head": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    marginBottom: "5px",
  },
  ".tc-comment-tools": { display: "flex", gap: "2px", opacity: "0", transition: "opacity 120ms" },
  ".tc-comment-card:hover .tc-comment-tools": { opacity: "1" },
  ".tc-comment-body": {
    fontSize: "13px",
    lineHeight: "1.45",
    color: "var(--color-fg)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".tc-comment-textarea": {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    margin: "6px 0",
    padding: "6px 8px",
    minHeight: "32px",
    maxHeight: "220px",
    overflowY: "auto",
    resize: "none",
    lineHeight: "1.45",
    borderRadius: "6px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg)",
    color: "var(--color-fg)",
    fontSize: "13px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    outline: "none",
  },
  ".tc-comment-textarea:focus": { borderColor: "var(--color-accent)" },
  ".tc-comment-actions": { display: "flex", alignItems: "center", gap: "8px" },
  ".tc-comment-hint": { fontSize: "11px", color: "var(--color-fg-faint)", marginRight: "auto" },
  ".tc-btn": {
    padding: "4px 11px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: "500",
    cursor: "pointer",
    border: "1px solid transparent",
  },
  ".tc-btn-ghost": { background: "transparent", color: "var(--color-fg-dim)", borderColor: "var(--color-border)" },
  ".tc-btn-ghost:hover": { background: "var(--color-hover)", color: "var(--color-fg)" },
  ".tc-btn-primary": { background: "var(--color-accent)", color: "var(--color-accent-fg)", borderColor: "var(--color-accent-deep)" },
  ".tc-btn-primary:hover": { background: "var(--color-accent-deep)", color: "#fff" },
  ".tc-icon-btn": {
    padding: "2px 7px",
    borderRadius: "5px",
    fontSize: "11px",
    cursor: "pointer",
    background: "transparent",
    border: "none",
    color: "var(--color-fg-faint)",
  },
  ".tc-icon-btn:hover": { background: "var(--color-hover)", color: "var(--color-fg)" },
  ".tc-icon-btn-danger:hover": { color: "var(--color-err)" },

  // Per-line hover gutter. A slim fixed column so the diff doesn't reflow as
  // the button appears/disappears; the marker only renders on the hovered line.
  ".tc-comment-gutter": { width: "20px" },
  // See the editorAttributes note in the factory: an idle selection-driven
  // gutter takes no horizontal room at all.
  "&.tc-gutter-idle .tc-comment-gutter": { width: "0px" },
  ".tc-comment-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  },
  ".tc-line-add-btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "17px",
    height: "17px",
    padding: "0",
    border: "none",
    borderRadius: "5px",
    cursor: "pointer",
    // The "+" glyph is the whole control here, so a low-contrast ink makes
    // the button look empty rather than merely hard to read.
    color: "var(--color-accent-fg)",
    background: "var(--color-accent)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
  },
  ".tc-line-add-btn:hover": { background: "var(--color-accent-deep)", color: "#fff" },
  ".tc-line-add-btn svg": { width: "12px", height: "12px" },
  ".tc-btn-send": { display: "inline-flex", alignItems: "center", gap: "5px" },
  ".tc-btn-send svg": { width: "12px", height: "12px" },
});
