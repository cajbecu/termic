// @vitest-environment happy-dom
//
// Cursor-line inline blame. Three things here are worth pinning, and they are
// the three that would silently produce a WRONG author rather than a visible
// break:
//
//  1. Annotation follows the cursor and only the cursor. A regression to
//     every-line is a performance regression, not a cosmetic one (see the
//     header comment in inlineBlameExt.ts on height-relevant decorations).
//  2. A line that was edited since the snapshot must NOT keep the old
//     commit's name. `MapMode.TrackBefore` is what drops the mark on a line
//     join, and the default `TrackDel` would slide it into the merged line and
//     confidently attribute someone else's code.
//  3. One git fork per file, cursor moves are memory lookups. That is the
//     whole reason VS Code's version feels instant.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { BlameFile } from "@/lib/types";

const blameMock = vi.hoisted(() => vi.fn());
const metaMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ taskGitBlame: blameMock, taskGitCommitMeta: metaMock }));

import { inlineBlameExtension, invalidateBlame, refreshBlame, markBlameStale, formatBlame, blameAgo, __resetBlameCache, __resetBlameMetaCache } from "./inlineBlameExt";

const TASK = "task-blame";
const FILE = "src/thing.ts";
const DOC = "one\ntwo\nthree\nfour\nfive\n";

/** Ada owns lines 1-2 and 5, Grace owns 3-4. */
const BLAME: BlameFile = {
  head: "abc123",
  skipped: false,
  commits: [
    {
      sha: "1111111111111111111111111111111111111111",
      author: "Ada", author_email: "ada@example.com",
      author_time: 1_700_000_000, summary: "teach the parser about tabs", uncommitted: false,
    },
    {
      sha: "2222222222222222222222222222222222222222",
      author: "Grace", author_email: "grace@example.com",
      author_time: 1_700_000_100, summary: "fix the off-by-one", uncommitted: false,
    },
  ],
  lines: [0, 0, 1, 1, 0],
};

let views: EditorView[] = [];

const opened: string[] = [];
const revealed: string[] = [];

function mount(doc = DOC, selection?: { anchor: number }) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent, doc, selection,
    extensions: [
      // Multi-cursor is off by default, and one case below needs two cursors.
      EditorState.allowMultipleSelections.of(true),
      inlineBlameExtension(TASK, FILE, {
        onOpenCommit: sha => opened.push(sha),
        onShowInHistory: sha => revealed.push(sha),
      }),
    ],
  });
  views.push(view);
  return view;
}

/** Put the cursor on a 1-based line. This is also what ARMS the fetch: the
 *  extension deliberately blames nothing until the cursor leaves position 0. */
function cursorToLine(view: EditorView, line: number) {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(line).from) });
}

/** Fake timers throughout: the card's open delay is a full second by design,
 *  and eight cases waiting it out for real made this file slower than the whole
 *  rest of the unit suite. Async advance, because the fetches settle on
 *  microtasks between timer ticks. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Matches CARD_DELAY_MS in the extension. */
const CARD_DELAY = 500;
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const card = (view: EditorView) =>
  document.querySelector(".cm-blame-card") as HTMLElement | null;

/** Hover the annotation until its card is up. Reuses `view` when given one. */
async function openCard(existing?: EditorView) {
  const view = existing ?? mount();
  if (!existing) {
    cursorToLine(view, 3);
    await settle();
  }
  const el = view.dom.querySelector(".cm-inline-blame") as HTMLElement;
  el.dispatchEvent(new MouseEvent("mouseenter"));
  await wait(CARD_DELAY + 120);
  await settle();
  return view;
}

const leaveCard = (view: EditorView) =>
  card(view)?.dispatchEvent(new MouseEvent("mouseleave"));

const annotations = (view: EditorView) =>
  Array.from(view.dom.querySelectorAll(".cm-inline-blame"), el => el.textContent ?? "");

beforeEach(() => {
  vi.useFakeTimers();
  __resetBlameCache();
  __resetBlameMetaCache();
  blameMock.mockReset();
  metaMock.mockReset();
  blameMock.mockResolvedValue(BLAME);
  metaMock.mockResolvedValue({
    sha: BLAME.commits[1].sha, short: "2222222", parents: [], subject: "fix the off-by-one",
    author: "Grace", email: "grace@example.com", timestamp: 1_700_000_100, refs: [], unpushed: false,
    body: "The index was one past the end.\n\nCo-authored-by: Ada <ada@example.com>",
  });
  opened.length = 0;
  revealed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const v of views) v.destroy();
  views = [];
  document.body.innerHTML = "";
});

describe("formatBlame", () => {
  const now = 1_700_000_000_000; // ms, same instant as Ada's commit

  it("reads subject, author, age, in VS Code's order", () => {
    const out = formatBlame(BLAME.commits[0], now + 3 * 24 * 3600 * 1000);
    expect(out).toBe("teach the parser about tabs, Ada (3d)");
  });

  it("truncates a long subject instead of pushing the author off screen", () => {
    const long = { ...BLAME.commits[0], summary: "x".repeat(80) };
    const out = formatBlame(long, now);
    // 50-char budget, ellipsis included, so the author is always reachable.
    expect(out.split(",")[0]).toHaveLength(50);
    expect(out).toContain("…");
    expect(out).toContain("Ada");
  });

  it("says nobody owns an uncommitted line", () => {
    const fresh = { ...BLAME.commits[0], uncommitted: true };
    expect(formatBlame(fresh, now)).toBe("Not committed yet");
  });
});

describe("inline blame annotation", () => {
  it("annotates only the cursor's line, and follows it", async () => {
    const view = mount();
    expect(annotations(view)).toEqual([]);   // nothing before the cursor moves

    cursorToLine(view, 3);
    await settle();
    const onGrace = annotations(view);
    expect(onGrace).toHaveLength(1);
    expect(onGrace[0]).toContain("Grace");

    cursorToLine(view, 1);
    await settle();
    const onAda = annotations(view);
    expect(onAda).toHaveLength(1);
    expect(onAda[0]).toContain("Ada");
    expect(onAda[0]).not.toContain("Grace");
  });

  it("annotates each distinct cursor line under a multi-cursor selection", async () => {
    const view = mount();
    // Line 1 starts at position 0, which is exactly the "file just opened,
    // cursor never moved" state the fetch deliberately ignores. Arm from a
    // real line first.
    cursorToLine(view, 3);
    await settle();
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(view.state.doc.line(1).from),
        EditorSelection.cursor(view.state.doc.line(4).from),
      ]),
    });
    const texts = annotations(view);
    expect(texts).toHaveLength(2);
    expect(texts.some(t => t.includes("Ada"))).toBe(true);
    expect(texts.some(t => t.includes("Grace"))).toBe(true);
  });

  it("forks git once per file and answers later cursor moves from memory", async () => {
    const view = mount();
    cursorToLine(view, 2);
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);

    for (const line of [1, 3, 4, 5, 2, 3]) cursorToLine(view, line);
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);

    // A second view of the same file (split view) reuses the cache too.
    const other = mount();
    cursorToLine(other, 2);
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);
  });

  it("annotates straight away when it is mounted onto a live cursor", async () => {
    // Turning the pref on (or reconfiguring the compartment) hands the plugin a
    // cursor that is already somewhere. Nothing should have to move for the
    // annotation to appear.
    const view = mount(DOC, { anchor: 6 });   // line 2
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);
    expect(annotations(view)[0]).toContain("Ada");
  });

  it("does not blame a file the cursor never entered", async () => {
    mount();
    await settle();
    expect(blameMock).not.toHaveBeenCalled();
  });

  it("stops claiming an author for a line that was edited since the snapshot", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    expect(annotations(view)[0]).toContain("Grace");

    // Join line 3 onto line 2 by deleting the newline before it. Line 3's
    // mark is dropped (TrackBefore) AND line 2's is dropped as touched, so
    // the merged line is attributed to nobody rather than to either half's
    // author.
    const line3 = view.state.doc.line(3);
    view.dispatch({ changes: { from: line3.from - 1, to: line3.from } });
    const after = annotations(view);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe("Not committed yet");
    expect(after[0]).not.toContain("Grace");
  });

  it("keeps attribution for untouched lines when an unrelated line is edited", async () => {
    const view = mount();
    cursorToLine(view, 5);
    await settle();
    expect(annotations(view)[0]).toContain("Ada");

    // Type inside line 1. Line 5 shifts but is not itself edited, so its mark
    // maps forward and Ada keeps it.
    view.dispatch({ changes: { from: 1, insert: "XYZ" } });
    cursorToLine(view, 5);
    expect(annotations(view)[0]).toContain("Ada");
  });

  it("defers a git tick's refetch to the next cursor move, and keeps showing the old author until then", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);
    expect(annotations(view)[0]).toContain("Grace");

    // A git tick (staging, unstaging, a commit) marks it stale. No fork, and
    // no blink: the Git panel emits these on every click, and re-blaming per
    // tick per open editor is the cost this exists to avoid.
    invalidateBlame(TASK, FILE);
    view.dispatch({ effects: markBlameStale.of() });
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);
    expect(annotations(view)[0]).toContain("Grace");

    // The next cursor move is when it pays for a fresh answer.
    blameMock.mockResolvedValue({
      ...BLAME,
      commits: [{ ...BLAME.commits[0], author: "Hopper", summary: "rewrote it all" }],
      lines: [0, 0, 0, 0, 0],
    });
    cursorToLine(view, 4);
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(2);
    expect(annotations(view)[0]).toContain("Hopper");
  });

  it("does not re-blame a dirty buffer, and does after a save", async () => {
    const view = mount();
    // Edit first, then move the cursor: blame reads DISK, so running it now
    // would return line numbers for a file that no longer matches the buffer.
    view.dispatch({ changes: { from: 0, insert: "zero\n" } });
    cursorToLine(view, 2);
    await settle();
    expect(blameMock).not.toHaveBeenCalled();

    // The save path drops the cache entry and dispatches refreshBlame.
    invalidateBlame(TASK, FILE);
    view.dispatch({ effects: refreshBlame.of() });
    await settle();
    expect(blameMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent for an untracked file and for one over the line cap", async () => {
    blameMock.mockResolvedValue({ commits: [], lines: [], head: "abc", skipped: false });
    const untracked = mount();
    cursorToLine(untracked, 2);
    await settle();
    expect(annotations(untracked)).toEqual([]);

    __resetBlameCache();
    blameMock.mockResolvedValue({ commits: [], lines: [], head: "abc", skipped: true });
    const huge = mount();
    cursorToLine(huge, 2);
    await settle();
    expect(annotations(huge)).toEqual([]);
  });

  it("says nothing on the phantom line a trailing newline creates", async () => {
    // "a\nb\n" is two lines to git and three to CodeMirror. The third is not
    // uncommitted work, it does not exist, so it gets no annotation at all.
    blameMock.mockResolvedValue({
      ...BLAME, lines: [0, 0],
    });
    const view = mount("a\nb\n");
    cursorToLine(view, 2);
    await settle();
    expect(annotations(view)[0]).toContain("Ada");

    cursorToLine(view, 3);
    expect(annotations(view)).toEqual([]);
  });

  it("survives a failed blame without throwing", async () => {
    blameMock.mockRejectedValue(new Error("not a git repository"));
    const view = mount();
    cursorToLine(view, 2);
    await settle();
    expect(annotations(view)).toEqual([]);
  });

  it("is inert: hovering opens a card, clicking the annotation does nothing", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    const el = view.dom.querySelector(".cm-inline-blame") as HTMLElement;

    // A click on the annotation must not open a diff. The actions live in the
    // card's header precisely because this sits inside an editable line.
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual([]);
    expect(card(view)).toBeNull();
  });

  it("opens the card only after the hover delay, not on the way past", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    const el = view.dom.querySelector(".cm-inline-blame") as HTMLElement;

    // Crossing it: enter, then leave well before the delay elapses.
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await wait(CARD_DELAY - 200);
    expect(card(view), "a card appeared while the pointer was just passing").toBeNull();
    el.dispatchEvent(new MouseEvent("mouseleave"));
    await wait(CARD_DELAY + 100);
    expect(card(view), "the cancelled timer still fired").toBeNull();

    // Resting on it: the card opens once the delay is up.
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await wait(CARD_DELAY + 120);
    expect(card(view)).not.toBeNull();
  });

  it("shows author, both dates, subject, message and co-authors", async () => {
    const view = await openCard();
    const text = card(view)!.textContent ?? "";
    expect(text).toContain("Grace");
    expect(text).toContain("ago");                       // relative
    expect(text).toMatch(/\d{4}/);                       // absolute, has a year
    expect(text).toContain("fix the off-by-one");        // subject
    // Body arrives from the lazy commit-meta fetch, not from the blame payload.
    expect(text).toContain("The index was one past the end.");
    expect(text).toContain("Ada");
    expect(text).toContain("co-author");
    // Trailers are not repeated as prose.
    expect(text).not.toContain("Co-authored-by:");
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("fetches a commit's message once and reuses it", async () => {
    const view = await openCard();
    leaveCard(view);
    await wait(400);
    expect(card(view)).toBeNull();
    await openCard(view);
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("still shows the header when the message body cannot be read", async () => {
    metaMock.mockRejectedValue(new Error("no such object"));
    const view = await openCard();
    const text = card(view)!.textContent ?? "";
    expect(text).toContain("Grace");
    expect(text).toContain("fix the off-by-one");   // the blame payload's subject
  });

  it("runs the header's two actions, and closes on an edit", async () => {
    const view = await openCard();
    const buttons = Array.from(card(view)!.querySelectorAll("button"));
    expect(buttons.map(b => b.textContent)).toEqual(["Open diff", "Show in History"]);

    buttons[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(opened).toEqual([BLAME.commits[1].sha]);
    buttons[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(revealed).toEqual([BLAME.commits[1].sha]);

    // The card describes a line that is now moving under it.
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(card(view)).toBeNull();
  });

  it("stays open while the pointer travels from the annotation into it", async () => {
    const view = await openCard();
    // Leaving the annotation arms a close; arriving in the card cancels it.
    (view.dom.querySelector(".cm-inline-blame") as HTMLElement)
      .dispatchEvent(new MouseEvent("mouseleave"));
    card(view)!.dispatchEvent(new MouseEvent("mouseenter"));
    await wait(400);
    expect(card(view), "the card closed before the pointer could reach it").not.toBeNull();

    // Leaving the card itself does close it.
    leaveCard(view);
    await wait(400);
    expect(card(view)).toBeNull();
  });

  it("never offers a card for an uncommitted line", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    view.dispatch({ changes: { from: view.state.doc.line(3).from, insert: "edited " } });
    expect(annotations(view)[0]).toBe("Not committed yet");
    const el = view.dom.querySelector(".cm-inline-blame") as HTMLElement;
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await wait(CARD_DELAY + 120);
    expect(card(view)).toBeNull();
    expect(metaMock).not.toHaveBeenCalled();
  });

  it("keeps the annotation out of the document text", async () => {
    const view = mount();
    cursorToLine(view, 3);
    await settle();
    expect(annotations(view)[0]).toContain("Grace");
    // The widget is a decoration, not content: what ⌘C copies (and what a
    // save writes) must be untouched.
    expect(view.state.doc.toString()).toBe(DOC);
  });
});
