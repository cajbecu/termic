// Inline git blame for the CURSOR'S LINE ONLY, as dimmed text after the code.
// VS Code's `git.blame.editorDecoration.enabled`, ported to CodeMirror 6.
//
// ── Why cursor-line-only, and not a blame column ──────────────────────────
// A per-line annotation on every line is the expensive shape, and CodeMirror
// makes that concrete. From `EditorView.decorations`: decoration sets given as
// a FUNCTION are computed after the viewport, so they may not introduce block
// widgets; sets given DIRECTLY may affect layout but cannot read the viewport.
// So an every-line blame column is either viewport-scoped and inline (rebuilt
// on every scroll) or directly-provided and height-relevant on all 15k lines.
// One widget on one line is neither: `estimatedHeight` -1 and `lineBreaks` 0
// keep it out of the height map entirely (view's `heightRelevant` getter), so
// moving the cursor never dirties layout.
//
// ── Where this deliberately diverges from VS Code ─────────────────────────
// VS Code blames at a SHA (`git blame --root --incremental <sha>`), which makes
// its cache entry immutable and never invalidated by an edit; it then maps the
// cursor's line back through the editor's quick-diff and prints "Not Committed
// Yet" for lines inside a working-tree change (extensions/git/src/blame.ts).
// That needs a live quick-diff model per editor, which termic does not have.
//
// We blame the WORKING TREE instead, so git itself attributes uncommitted
// lines (the all-zero sha) and the line numbers already match the file on
// disk. The cost is that the cache is invalidated by writes rather than being
// immutable, hence `invalidateBlame` on save / external reload / commit.
//
// For the window where the buffer is dirty and disk is stale, the snapshot's
// line starts ride along as a mapped RangeSet: `MapMode.TrackBefore` drops a
// mark when the newline before it is deleted, which is exactly "this line
// stopped existing". A line with no surviving mark reads "Not committed yet",
// same words VS Code uses, arrived at without a diff engine.

import { EditorView, Decoration, WidgetType, type DecorationSet, ViewPlugin, type ViewUpdate, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, RangeValue, MapMode, type EditorState } from "@codemirror/state";
import type { BlameCommit, BlameFile, GitCommit } from "@/lib/types";
import { taskGitBlame, taskGitCommitMeta } from "@/lib/ipc";
import { commitAge } from "@/lib/commitAge";
import { splitTrailers } from "@/lib/commitMessage";
import { useUI } from "@/store/ui";

/** Git's sentinel for "no commit owns this line" in our wire format. */
const NO_COMMIT = 0xffffffff;

/** VS Code truncates the subject at 50 chars (`_subjectMaxLength`), and the
 *  same reason applies here: this is one line of dimmed text trailing real
 *  code, not a place to read a commit message. */
const SUBJECT_MAX = 50;

/** What a line with no attribution says. Matches VS Code's wording. */
const UNCOMMITTED = "Not committed yet";

/** How long the pointer must rest on the annotation before its card opens. Long
 *  enough that crossing the annotation on the way somewhere else does not throw
 *  a card over the next line, short enough that resting on it feels answered. */
const CARD_DELAY_MS = 500;

/** Grace between the pointer leaving the annotation and the card closing, so it
 *  can travel INTO the card to reach the buttons. Without it the card is
 *  unreachable and its header is decoration. */
const CARD_CLOSE_MS = 220;

// ───────────────────────── whole-file cache ─────────────────────────

/** One entry per (task, file). VS Code caches the whole file's blame in an
 *  LRU of 100 per repository and looks up the cursor's line in memory; the
 *  annotation feels instant because a cursor move costs an array index, not a
 *  git fork. Same idea here, with the same cap. */
const MAX_CACHED_FILES = 100;
const cache = new Map<string, BlameFile>();
const inFlight = new Map<string, Promise<BlameFile | null>>();

/** `|` rather than a NUL: a task id is a uuid so it cannot contain one, which
 *  makes the key unambiguous, and unlike NUL it does not make this whole source
 *  file read as BINARY to grep and every other line-oriented tool. */
const keyFor = (taskId: string, path: string) => `${taskId}|${path}`;

/** Fetch-once-per-file, with in-flight dedupe so two mounted views of the
 *  same path (split view) fork git once. */
function loadBlame(taskId: string, path: string): BlameFile | Promise<BlameFile | null> {
  const key = keyFor(taskId, path);
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU recency: delete + re-set moves it to the tail.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = taskGitBlame(taskId, path)
    .then(data => {
      cache.set(key, data);
      if (cache.size > MAX_CACHED_FILES) {
        // Oldest insertion first, which after the touch above is the
        // least-recently-used entry.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return data;
    })
    // A failed blame is not worth surfacing: the annotation is an
    // affordance, and a toast per opened file would be worse than silence.
    .catch(() => null)
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/** Drop cached blame. Call after anything that changes what git would say:
 *  a save, an external reload, a commit. With no `path`, drops the whole
 *  task (a commit re-attributes every file, not one). */
export function invalidateBlame(taskId: string, path?: string) {
  if (path) {
    cache.delete(keyFor(taskId, path));
    return;
  }
  const prefix = `${taskId}|`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/** Tests only: forget everything, including in-flight promises. */
export function __resetBlameCache() {
  cache.clear();
  inFlight.clear();
}

// ───────────────────────── line anchoring ─────────────────────────

/** A mark at one line's start, carrying the 1-based line number the blame
 *  snapshot knew it as.
 *
 *  `MapMode.TrackBefore` is the whole point: CodeMirror drops the mark when
 *  the character before it is deleted, i.e. when the preceding newline goes
 *  and this line is joined onto the previous one. `Decoration.line` uses the
 *  same mode for the same reason. The default (`TrackDel`) would keep the
 *  mark and slide it into the middle of the merged line, which is how a
 *  trailing annotation ends up attributed to the wrong commit. */
class BlameLine extends RangeValue {
  point = true;
  mapMode = MapMode.TrackBefore;
  startSide = -1;
  endSide = -1;
  constructor(readonly line: number) { super(); }
  eq(other: BlameLine) { return other.line === this.line; }
}

/** Line-start marks for a fresh snapshot. Only built when blame data lands,
 *  and the Rust side refuses files over 2 MB, so this is bounded. */
function marksForDoc(state: EditorState, lineCount: number): RangeSet<BlameLine> {
  const ranges = [];
  const max = Math.min(lineCount, state.doc.lines);
  for (let n = 1; n <= max; n++) {
    ranges.push(new BlameLine(n).range(state.doc.line(n).from));
  }
  return RangeSet.of(ranges);
}

// ───────────────────────── formatting ─────────────────────────

/** VS Code's default template is `${subject}, ${authorName} (${authorDateAgo})`
 *  and this is that, with `commitAge`'s terser age so the editor and the
 *  History panel say the same thing about the same commit. */
export function formatBlame(c: BlameCommit, now = Date.now()): string {
  if (c.uncommitted) return UNCOMMITTED;
  const subject = c.summary.length > SUBJECT_MAX
    ? `${c.summary.slice(0, SUBJECT_MAX - 1)}…`
    : c.summary;
  const age = commitAge(c.author_time, now);
  const parts = [subject, c.author].filter(Boolean);
  const head = parts.join(", ");
  return age ? `${head} (${age})` : head;
}

/** Absolute date for the card's header, next to the relative age. VS Code shows
 *  both ("3 weeks ago (July 23, 2026 at 5:05 PM)") because the relative one
 *  answers "is this recent" and the absolute one answers "which release". */
export function blameFullDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

/** "3 weeks ago", spelled out. `commitAge` is the terse form the History rows
 *  and the annotation itself use; the card has room for prose. */
export function blameAgo(unixSeconds: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  const units: [number, string][] = [
    [31_536_000, "year"], [2_592_000, "month"], [604_800, "week"],
    [86_400, "day"], [3_600, "hour"], [60, "minute"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(secs / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

// ───────────────────────── the hover card ─────────────────────────

/** Commit detail, per sha, for cards already opened once. Bounded like the blame
 *  cache: a reader hovers a handful of lines, not a hundred. */
const META_MAX = 100;
const metaCache = new Map<string, GitCommit>();
const metaInFlight = new Map<string, Promise<GitCommit | null>>();

/** Tests only. */
export function __resetBlameMetaCache() {
  metaCache.clear();
  metaInFlight.clear();
}

function loadMeta(taskId: string, path: string, sha: string) {
  const hit = metaCache.get(sha);
  if (hit) return hit;
  const pending = metaInFlight.get(sha);
  if (pending) return pending;
  const p = taskGitCommitMeta(taskId, path, sha)
    .then(c => {
      metaCache.set(sha, c);
      if (metaCache.size > META_MAX) {
        const oldest = metaCache.keys().next().value;
        if (oldest !== undefined) metaCache.delete(oldest);
      }
      return c;
    })
    .catch(() => null)
    .finally(() => { metaInFlight.delete(sha); });
  metaInFlight.set(sha, p);
  return p;
}

/** Which annotation's card is open. `line` is where to anchor it; `sha` is what
 *  to show. Null closes it. */
const setBlameCard = StateEffect.define<{ line: number; sha: string } | null>();
/** The body arriving for an already-open card. Separate from `setBlameCard` so
 *  the card renders its header immediately and fills in the message when git
 *  answers, rather than waiting for a fork before showing anything. */
const setCardMeta = StateEffect.define<{ sha: string; meta: GitCommit | null }>();

interface CardState {
  open: { line: number; sha: string } | null;
  /** Body for the open card's sha, once fetched. */
  meta: GitCommit | null;
}

const cardField = StateField.define<CardState>({
  create: () => ({ open: null, meta: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setBlameCard)) {
        // A different sha invalidates any body already in hand.
        next = { open: e.value, meta: e.value && e.value.sha === value.open?.sha ? value.meta : null };
      } else if (e.is(setCardMeta) && next.open?.sha === e.value.sha) {
        next = { ...next, meta: e.value.meta };
      }
    }
    // Any edit closes it: the card describes a line that is moving under it.
    if (tr.docChanged && next.open) next = { open: null, meta: null };
    return next;
  },
});

/** Close timers live outside CodeMirror state: they are per view, not per
 *  document, and a pending timeout is not something to map through changes. */
const closeTimers = new WeakMap<EditorView, number>();

function cancelClose(view: EditorView) {
  const t = closeTimers.get(view);
  if (t !== undefined) { clearTimeout(t); closeTimers.delete(view); }
}

/** Close after the travel grace, unless the pointer arrives somewhere that
 *  cancels it (the card itself, or the annotation again). */
function closeCardSoon(view: EditorView) {
  cancelClose(view);
  const t = window.setTimeout(() => {
    closeTimers.delete(view);
    if (view.dom.isConnected && view.state.field(cardField, false)?.open) {
      view.dispatch({ effects: setBlameCard.of(null) });
    }
  }, CARD_CLOSE_MS);
  closeTimers.set(view, t);
}

// ───────────────────────── state ─────────────────────────

const setBlame = StateEffect.define<BlameFile | null>();
/** Forget the snapshot and ask for a new one NOW. Dispatched after a save or an
 *  external reload, where the file on disk (and so what git blames) has just
 *  changed under a buffer the reader is looking at. */
export const refreshBlame = StateEffect.define<void>();
/** The snapshot may be out of date, but keep showing it until the reader moves.
 *  Dispatched on a git tick, which fires for staging and unstaging as well as
 *  for commits: re-blaming eagerly there would fork git on every click in the
 *  Git panel, per open editor, to redraw one line that usually did not change.
 *  The refetch rides the next cursor move instead, and until then the
 *  annotation stays put rather than blinking out. */
export const markBlameStale = StateEffect.define<void>();

interface BlameState {
  data: BlameFile | null;
  /** Snapshot line starts, mapped through every edit since the snapshot. */
  marks: RangeSet<BlameLine>;
  /** Git moved under us. What is on screen stays on screen, but it should be
   *  replaced at the next opportunity. See `markBlameStale`. */
  stale: boolean;
}

const blameField = StateField.define<BlameState>({
  create: () => ({ data: null, marks: RangeSet.empty, stale: false }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setBlame)) {
        const data = e.value;
        next = {
          data,
          marks: data && data.lines.length ? marksForDoc(tr.state, data.lines.length) : RangeSet.empty,
          stale: false,
        };
      } else if (e.is(refreshBlame)) {
        next = { data: null, marks: RangeSet.empty, stale: false };
      } else if (e.is(markBlameStale)) {
        next = { ...next, stale: true };
      }
    }
    // Map the snapshot forward. RangeSet.map is chunk-granular and reuses
    // untouched chunks, so a keystroke costs one chunk, not 15k marks.
    if (tr.docChanged && next.marks.size) {
      let marks = next.marks.map(tr.changes);
      // Mapping alone is not enough. TrackBefore drops a line that was JOINED
      // onto the one above, but the survivor's own mark is untouched, so the
      // merged line would be attributed to whoever owned the first half. Any
      // line an edit touched has to lose its mark: it now contains text no
      // commit in the snapshot describes. This is VS Code's "Not Committed
      // Yet" for lines inside a working-tree change, reached without a diff.
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const first = tr.state.doc.lineAt(fromB).from;
        const last = tr.state.doc.lineAt(toB).from;
        // Bounded filter: `filterFrom`/`filterTo` keep this to the touched
        // chunk instead of walking every mark in the file.
        marks = marks.update({
          filter: from => from < first || from > last,
          filterFrom: first,
          filterTo: last,
        });
      });
      next = { ...next, marks };
    }
    return next;
  },
});

/** The snapshot line number for a current-doc line, or 0 if this line has no
 *  surviving mark (it was inserted, or absorbed by a join). */
function snapshotLine(state: EditorState, docLine: number): number {
  const { marks } = state.field(blameField);
  if (!marks.size) return 0;
  const from = state.doc.line(docLine).from;
  let found = 0;
  marks.between(from, from, (_f, _t, v) => { found = v.line; return false; });
  return found;
}

/** The commit for the cursor's line, `null` when blame says nothing about it
 *  and `"uncommitted"` when the line has drifted out of the snapshot. */
function commitForLine(state: EditorState, docLine: number): BlameCommit | null {
  const { data } = state.field(blameField);
  if (!data || data.skipped || !data.lines.length) return null;
  const snap = snapshotLine(state, docLine);
  if (snap === 0) {
    // Past the end of what git described, with no edit involved: a file that
    // ends in a newline gives CodeMirror a phantom final line that no commit
    // owns and none ever will. Say nothing there, rather than claiming it is
    // uncommitted work.
    if (docLine > data.lines.length) return null;
    // Otherwise the line was edited since the snapshot. Honest about that
    // rather than attributing it to whoever owned it before the edit.
    return { sha: "", author: "", author_email: "", author_time: 0, summary: "", uncommitted: true };
  }
  const idx = data.lines[snap - 1];
  if (idx === undefined || idx === NO_COMMIT) return null;
  return data.commits[idx] ?? null;
}

// ───────────────────────── the widget ─────────────────────────

class BlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly line: number,
    readonly sha: string,
  ) { super(); }

  /** Same text on the same line = same widget, so CodeMirror keeps the DOM node
   *  instead of rebuilding it. This is what makes holding an arrow key down
   *  cheap, and it also keeps an open hover card's anchor stable. */
  eq(other: BlameWidget) {
    return other.text === this.text && other.sha === this.sha && other.line === this.line;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-inline-blame";
    el.textContent = this.text;
    // NOT clickable. The annotation sits inside the line the reader is editing,
    // so a click target there competes with placing the cursor; the actions live
    // in the hover card's header instead.
    //
    // `user-select: none` in the theme keeps it out of a manual DOM selection.
    // CodeMirror's own copy path slices the document rather than the DOM, so ⌘C
    // on the line never sees it either way.
    if (!this.sha) return el;   // uncommitted: nothing to show a card about

    let timer: number | undefined;
    const cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    el.addEventListener("mouseenter", () => {
      cancel();
      // A full second, deliberately: the annotation sits in the middle of code
      // the reader is scanning, and a card that appears on the way past would
      // cover the next line every time the mouse crossed it.
      timer = window.setTimeout(() => {
        timer = undefined;
        view.dispatch({ effects: setBlameCard.of({ line: this.line, sha: this.sha }) });
      }, CARD_DELAY_MS);
    });
    el.addEventListener("mouseleave", () => {
      cancel();
      // Closing is the CARD's business once it is open: the pointer has to be
      // able to travel from here into it to reach the buttons.
      closeCardSoon(view);
    });
    return el;
  }

  /** Events here are the widget's own; without this CodeMirror treats a
   *  mousedown as a click in the document and moves the cursor. */
  ignoreEvent() { return true; }
}

// ───────────────────────── decorations ─────────────────────────

/** One annotation per distinct cursor line, same as VS Code (which iterates
 *  `new Set(selections.map(s => s.active.line))`). */
function computeDeco(
  state: EditorState,
  onOpenCommit?: (sha: string) => void,
): { set: DecorationSet; key: string } {
  const seen = new Set<number>();
  const ranges = [];
  const keyParts: string[] = [];
  for (const r of state.selection.ranges) {
    const line = state.doc.lineAt(r.head);
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    const commit = commitForLine(state, line.number);
    if (!commit) continue;
    const text = formatBlame(commit);
    keyParts.push(`${line.number}:${commit.sha}:${text}`);
    ranges.push(
      Decoration.widget({
        widget: new BlameWidget(text, line.number, commit.uncommitted ? "" : commit.sha),
        // After the cursor when the cursor sits at end of line, per the
        // `side` doc ("positive: drawn after the cursor").
        side: 1,
      }).range(line.to),
    );
  }
  return { set: Decoration.set(ranges, true), key: keyParts.join("|") };
}

// ───────────────────────── the extension ─────────────────────────

export interface InlineBlameOptions {
  /** "Open diff" in the card's header: this file as that commit changed it.
   *  Wired by EditorPane to the same `commit:<sha>` diff tab the History panel
   *  opens. NOT reachable by clicking the annotation, which is deliberately
   *  inert: it sits inside the line being edited, where a click target competes
   *  with placing the cursor. */
  onOpenCommit?: (sha: string) => void;
  /** "Show in History" in the card's header. Defaults to the UI store's
   *  `revealCommitInHistory`, which opens the right panel's Git tab, switches it
   *  to the Graph and expands that commit. Injectable for tests. */
  onShowInHistory?: (sha: string) => void;
}

/** The card's DOM. Header first (author, age, absolute date, then the two
 *  actions), then co-authors, then the message prose. The body arrives after the
 *  header, so this renders in both states rather than waiting on git. */
function buildCard(
  commit: BlameCommit,
  meta: GitCommit | null,
  opts: InlineBlameOptions,
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-blame-card";

  const header = document.createElement("div");
  header.className = "cm-blame-card-head";

  const who = document.createElement("div");
  who.className = "cm-blame-card-who";
  const name = document.createElement("span");
  name.className = "cm-blame-card-author";
  name.textContent = commit.author;
  const when = document.createElement("span");
  when.className = "cm-blame-card-when";
  when.textContent = `${blameAgo(commit.author_time)} (${blameFullDate(commit.author_time)})`;
  who.append(name, when);

  const actions = document.createElement("div");
  actions.className = "cm-blame-card-actions";
  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-blame-card-btn";
    b.textContent = label;
    b.title = title;
    // mousedown, not click: CodeMirror sees mousedown first and would move the
    // cursor into the document behind the card.
    b.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); run(); });
    return b;
  };
  if (opts.onOpenCommit) {
    actions.append(button("Open diff", "Diff this file as this commit changed it",
      () => opts.onOpenCommit?.(commit.sha)));
  }
  if (opts.onShowInHistory) {
    actions.append(button("Show in History", "Reveal this commit in the Git tab's Graph",
      () => opts.onShowInHistory?.(commit.sha)));
  }

  header.append(who, actions);

  const sha = document.createElement("div");
  sha.className = "cm-blame-card-sha";
  sha.textContent = commit.sha.slice(0, 8);

  dom.append(header, sha);

  const { prose, coAuthors } = splitTrailers(meta?.body ?? "");
  if (coAuthors.length) {
    const co = document.createElement("div");
    co.className = "cm-blame-card-co";
    co.textContent = `${coAuthors.join(", ")} (${coAuthors.length === 1 ? "co-author" : "co-authors"})`;
    dom.append(co);
  }

  const subject = document.createElement("div");
  subject.className = "cm-blame-card-subject";
  // The full subject, not the annotation's 50-char truncation: the card is
  // where the whole message belongs.
  subject.textContent = meta?.subject || commit.summary;
  dom.append(subject);

  if (prose) {
    const body = document.createElement("div");
    body.className = "cm-blame-card-body";
    body.textContent = prose;
    dom.append(body);
  }
  return dom;
}


/**
 * Cursor-line inline blame. Mount through a Compartment so the pref can turn
 * it off without rebuilding the view; with it off, nothing here is
 * constructed at all (VS Code tears its listeners down the same way).
 */
export function inlineBlameExtension(taskId: string, path: string, opts: InlineBlameOptions = {}) {
  const decoPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    // Recomputed on selection/doc/data change, but the DecorationSet REFERENCE
    // is reused when the rendered text is identical. VS Code suppresses the
    // same way (`isResourceBlameInformationEqual`), and it matters more here:
    // an unchanged directly-provided set short-circuits CodeMirror's
    // height-map compare. Per-instance, not per-extension, so two views can
    // never read each other's last render.
    private lastKey: string | null = null;

    constructor(view: EditorView) { this.sync(view); }

    update(u: ViewUpdate) {
      const dataChanged = u.startState.field(blameField) !== u.state.field(blameField);
      if (u.selectionSet || u.docChanged || dataChanged) this.sync(u.view);
    }

    private sync(view: EditorView) {
      const { set, key } = computeDeco(view.state, opts.onOpenCommit);
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.decorations = set;
    }
  }, { decorations: v => v.decorations });

  // Fetching is deferred until the cursor moves off the very start of the
  // document. VS Code has the same guard (blame.ts skips a selection that is
  // exactly [0,0,0,0] unless the change came from a real selection event),
  // and here it also means the editor's open path never waits on git and a
  // stack of mounted-but-hidden tabs blames nothing.
  const fetchPlugin = ViewPlugin.fromClass(class {
    /** The buffer has edits the file on disk does not, so blame's line
     *  numbers would not line up with what is on screen. Cleared by the save
     *  path's `refreshBlame`, which is the moment disk matches again. */
    private dirty = false;
    /** The cursor has been somewhere other than the very start of the doc, so
     *  this is a file the user is actually reading. A refresh only re-fetches
     *  for such a view, which is what stops a git tick forking `git blame`
     *  once per mounted-but-never-looked-at tab. */
    private armed = false;
    /** A fetch is outstanding. Guarded here rather than in the state field
     *  because the claim has to be effective IMMEDIATELY, and a plugin cannot
     *  dispatch into state during an update (see `fetch`). */
    private claimed = false;

    constructor(readonly view: EditorView) {
      // Arm from the cursor we are handed, not only from a later move. This is
      // the toggle-on case: switch the pref on (or reconfigure the compartment)
      // while parked on a line and the annotation should appear there, not wait
      // for the next keystroke. A cursor still at position 0 means "file just
      // opened, nobody has looked at it", which is the case worth skipping.
      if (view.state.selection.main.head !== 0) {
        this.armed = true;
        this.fetch();
      }
    }

    update(u: ViewUpdate) {
      if (u.docChanged) this.dirty = true;
      if (u.selectionSet && u.state.selection.main.head !== 0) this.armed = true;
      if (u.transactions.some(tr => tr.effects.some(e => e.is(refreshBlame)))) {
        // The save (or reload) path: disk matches the buffer again, and the
        // snapshot has been dropped, so this view may ask afresh.
        this.dirty = false;
        this.claimed = false;
      }
      const st = u.state.field(blameField);
      // The deferred refetch a git tick asked for: take it on a cursor move,
      // when the reader is already looking somewhere new. One fork per move
      // they make, not one per tick the Git panel emits.
      const takeStale = st.stale && u.selectionSet;
      if (takeStale) this.claimed = false;
      if (this.claimed || this.dirty || !this.armed) return;
      // Already answered and still believed current.
      if (st.data && !takeStale) return;
      this.fetch();
    }

    private fetch() {
      this.claimed = true;
      const view = this.view;
      const generation = this.dirty;
      // A ViewPlugin must NOT dispatch while an update is in progress
      // ("Calls to EditorView.update are not allowed while an update is in
      // progress"), and this runs from `update`. The microtask also collapses
      // a burst of cursor moves into one fetch.
      void Promise.resolve(loadBlame(taskId, path)).then(data => {
        // The view can be torn down while git runs (tab closed, file
        // switched); dispatching into a detached view is pointless at best.
        if (!view.dom.isConnected) return;
        // Typed while git was running: the snapshot describes a file that is
        // already stale, and anchoring it to the edited doc would attribute
        // the wrong commits. Drop it and wait for the next save.
        if (this.dirty !== generation) {
          this.claimed = false;
          return;
        }
        view.dispatch({ effects: setBlame.of(data) });
      });
    }
  });

  // Resolved once: the card's buttons close over these rather than reaching for
  // the store at render time.
  const cardOpts: InlineBlameOptions = {
    onOpenCommit: opts.onOpenCommit,
    onShowInHistory: opts.onShowInHistory
      ?? (sha => useUI.getState().revealCommitInHistory(taskId, sha)),
  };

  /** The card, as a CodeMirror tooltip: CodeMirror owns the positioning, the
   *  flipping and the clipping, which is the whole reason not to hand-roll a
   *  floating panel. Anchored at the line's end, where the annotation is. */
  const tooltipField = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      const card = tr.state.field(cardField);
      if (!card.open) return [];
      const line = card.open.line;
      if (line > tr.state.doc.lines) return [];
      const commit = commitForLine(tr.state, line);
      if (!commit || commit.uncommitted) return [];
      const pos = tr.state.doc.line(line).to;
      const meta = card.meta;
      return [{
        pos,
        above: true,
        create: (view: EditorView) => {
          const dom = buildCard(commit, meta, cardOpts);
          // The pointer has to be able to live in here: entering cancels the
          // close the annotation's mouseleave scheduled, leaving re-arms it.
          dom.addEventListener("mouseenter", () => cancelClose(view));
          dom.addEventListener("mouseleave", () => closeCardSoon(view));
          return { dom };
        },
      }];
    },
    provide: f => showTooltip.computeN([f], state => state.field(f)),
  });

  /** Fetches the message body once a card is open, then dispatches it in. The
   *  header is already on screen by then, so this fills the card in rather than
   *  delaying it. */
  const metaPlugin = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      const card = u.state.field(cardField);
      if (!card.open || card.meta) return;
      if (u.startState.field(cardField).open?.sha === card.open.sha) return;
      const sha = card.open.sha;
      const view = this.view;
      void Promise.resolve(loadMeta(taskId, path, sha)).then(meta => {
        if (!view.dom.isConnected) return;
        if (view.state.field(cardField).open?.sha !== sha) return;   // moved on
        view.dispatch({ effects: setCardMeta.of({ sha, meta }) });
      });
    }
  });

  return [
    blameField,
    cardField,
    tooltipField,
    metaPlugin,
    decoPlugin,
    fetchPlugin,
    EditorView.baseTheme({
      ".cm-inline-blame": {
        // 50px matches VS Code's `margin: '0 0 0 50px'` on the annotation, so
        // the gap reads as deliberate separation rather than trailing code.
        marginLeft: "50px",
        // `--color-fg-faint`, and it has to be a token that EXISTS: an unknown
        // custom property makes the declaration invalid at computed-value time,
        // so `color` falls back to inherited, i.e. the code's own foreground.
        // That is how this shipped looking like ordinary white code.
        color: "var(--color-fg-faint)",
        fontStyle: "normal",
        // Never let the annotation widen the line box enough to trigger a
        // horizontal scrollbar of its own.
        whiteSpace: "pre",
        // Hoverable (the card is the only affordance) but never a click target:
        // this sits inside the line being edited.
        pointerEvents: "auto",
        userSelect: "none",
        cursor: "default",
      },

      // ── the hover card ──
      ".cm-blame-card": {
        // A MINIMUM matters more than the maximum here. The annotation sits at
        // the end of a line, so there is often only a sliver of room to its
        // right; with no min width the card shrink-to-fits into that sliver,
        // wraps its header into a column and overlaps its own buttons. Given a
        // min width it cannot fit, CodeMirror shifts it LEFT instead, which is
        // what we want (see the `tooltipSpace` note in EditorPane).
        minWidth: "360px",
        maxWidth: "560px",
        boxSizing: "border-box",
        // Never taller than the pane it has to fit inside; the message body
        // scrolls within this.
        maxHeight: "40vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        padding: "10px 12px",
        borderRadius: "6px",
        border: "1px solid var(--color-border-soft)",
        background: "var(--color-bg-2)",
        color: "var(--color-fg-dim)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
        fontSize: "12.5px",
        lineHeight: "1.5",
      },
      ".cm-blame-card-head": {
        display: "flex",
        alignItems: "center",
        // Wraps to a second row rather than letting the buttons ride over the
        // author line when the card is at its narrowest.
        flexWrap: "wrap",
        columnGap: "16px",
        rowGap: "6px",
      },
      ".cm-blame-card-who": {
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        minWidth: "0",
        flexWrap: "wrap",
      },
      ".cm-blame-card-author": { color: "var(--color-fg)", fontWeight: "500" },
      ".cm-blame-card-when": {
        color: "var(--color-fg-faint)",
        fontSize: "11.5px",
        // One line: "2 years ago (January 19, 2024 at 11:45 PM)" broken across
        // four lines is what a squeezed card used to look like.
        whiteSpace: "nowrap",
      },
      ".cm-blame-card-actions": { display: "flex", gap: "6px", flexShrink: "0", marginLeft: "auto" },
      ".cm-blame-card-btn": {
        padding: "2px 8px",
        borderRadius: "4px",
        border: "1px solid var(--color-border-soft)",
        background: "transparent",
        color: "var(--color-fg-dim)",
        font: "inherit",
        fontSize: "11.5px",
        cursor: "pointer",
      },
      ".cm-blame-card-btn:hover": {
        background: "var(--color-hover)",
        color: "var(--color-fg)",
      },
      ".cm-blame-card-sha": {
        marginTop: "2px",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        color: "var(--color-fg-faint)",
      },
      ".cm-blame-card-co": { marginTop: "6px", fontSize: "11.5px", color: "var(--color-fg-faint)" },
      ".cm-blame-card-subject": { marginTop: "8px", color: "var(--color-fg)" },
      ".cm-blame-card-body": {
        marginTop: "6px",
        // A long message scrolls inside the card instead of growing it past the
        // viewport; the History panel's hover card caps itself the same way.
        minHeight: "0",
        overflow: "auto",
        whiteSpace: "pre-wrap",
      },
    }),
  ];
}
