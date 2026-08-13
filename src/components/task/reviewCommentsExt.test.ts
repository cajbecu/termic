// @vitest-environment happy-dom
//
// GH #157: the gutter drifted out of step with the code, ~12px per review
// comment, cumulative. CodeMirror fills its height map from each block widget's
// BORDER BOX, so vertical margin on the element `toDOM` returns is space it
// never counts, and a widget that grows after being measured goes stale.
//
// No layout engine here, so these pin the structure that makes the geometry
// correct, not the geometry: the measured element keeps the card's spacing
// inside itself, and a growing composer re-syncs the height map. Real pixel
// alignment is the "review comment alignment" case in e2e/specs/git.e2e.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { reviewCommentsExtension, dispatchFileComment, dispatchSelectionComment } from "./reviewCommentsExt";
import { useReviewComments } from "@/store/reviewComments";

const TASK = "task-157";
const FILE = "src/thing.ts";
const DOC = "one\ntwo\nthree\nfour\nfive\n";

let views: EditorView[] = [];

const EDITOR_SURFACE = { selection: "gutter", hoverGutter: false, source: "editor" } as const;

function mount(surface?: Parameters<typeof reviewCommentsExtension>[2]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc: DOC,
    extensions: [reviewCommentsExtension(TASK, FILE, surface)],
  });
  views.push(view);
  return view;
}

/** storeSyncPlugin seeds on a microtask, and widgets mount on the next tick. */
const settle = () => new Promise(r => setTimeout(r, 0));

function addComment(line: number, body: string) {
  return useReviewComments.getState().add({
    taskId: TASK, file: FILE, startLine: line, endLine: line, quote: "x", body,
  });
}

/** The element CodeMirror measures for a widget: the shell we mounted it in. */
const measuredBox = (inner: Element) => inner.parentElement!;

/** happy-dom leaves unset lengths as "", which is 0 for our purposes. */
const px = (v: string) => parseFloat(v) || 0;

/**
 * Does this element hold a child's vertical margin inside its border box? We
 * use `flow-root`, but padding or any other block formatting context works too,
 * so assert the property rather than the implementation.
 */
function containsChildMargins(el: Element): boolean {
  const s = getComputedStyle(el);
  return ["flow-root", "flex", "grid", "table", "inline-block"].includes(s.display)
    || (s.overflow !== "" && s.overflow !== "visible")
    || px(s.paddingTop) > 0;
}

/** The invariant the gutter depends on, asserted on the element CM measures. */
function expectMeasuredBox(inner: Element, view: EditorView) {
  const box = measuredBox(inner);
  expect(box, "widget is not wrapped in a shell").not.toBe(view.contentDOM);
  expect(containsChildMargins(box), `${box.firstElementChild?.className} shell is not a BFC`).toBe(true);
  expect({ top: px(getComputedStyle(box).marginTop), bottom: px(getComputedStyle(box).marginBottom) })
    .toEqual({ top: 0, bottom: 0 });
}

beforeEach(() => {
  useReviewComments.getState().clear(TASK);
});

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("review comment block widgets", () => {
  it("mounts a comment card in a measured box that owns its spacing", async () => {
    addComment(2, "look at this");
    const view = mount();
    await settle();

    const card = view.contentDOM.querySelector(".tc-comment-card");
    expect(card).toBeTruthy();
    expectMeasuredBox(card!, view);

    // Guards against passing vacuously: if the spacing were simply deleted, a
    // zero-margin measured box would prove nothing. The margin must still exist,
    // just contained.
    const s = getComputedStyle(card!);
    expect(px(s.marginTop)).toBeGreaterThan(0);
    expect(px(s.marginBottom)).toBeGreaterThan(0);
  });

  it("mounts the composer the same way", async () => {
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    const composer = view.contentDOM.querySelector(".tc-comment-composer");
    expect(composer).toBeTruthy();
    expectMeasuredBox(composer!, view);
  });

  it("holds for every block widget once several comments stack up", async () => {
    // The reported case: drift was invisible at one comment and obvious at
    // three, so assert the invariant across all of them at once.
    addComment(1, "a");
    addComment(3, "b");
    addComment(5, "c");
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    expect(view.contentDOM.querySelectorAll(".tc-comment-card")).toHaveLength(3);

    // Anything in the content column that is not a line is a block widget, so
    // this also catches a NEW widget added later without a shell.
    const blocks = Array.from(view.contentDOM.children).filter(el => !el.classList.contains("cm-line"));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) expectMeasuredBox(b.firstElementChild!, view);
  });

  it("re-measures when the composer's textarea grows", async () => {
    // The other half of the fix: the textarea auto-grows past the height
    // CodeMirror measured on mount, which leaves a stale height in the map.
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle(); // mount's own autoGrow has run by here

    const ta = view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!;
    const requestMeasure = vi.spyOn(view, "requestMeasure");

    ta.value = "one\ntwo\nthree";
    ta.dispatchEvent(new Event("input"));

    expect(requestMeasure).toHaveBeenCalled();
  });
});

describe("composer payload", () => {
  /** Put a selection on lines 2-3 and open the composer on it. */
  function composeOnLines2to3(view: EditorView) {
    const from = view.state.doc.line(2).from;
    const to = view.state.doc.line(3).to;
    view.dispatch({ selection: { anchor: from, head: to } });
    return dispatchSelectionComment(view);
  }

  it("shows the selected code above the box, not just its line range", async () => {
    // The composer used to show "thing.ts · lines 2-3" and nothing else, so a
    // send looked like it was sending line numbers at a file the agent would
    // have to go read. The snippet that actually travels is on screen now.
    const view = mount(EDITOR_SURFACE);
    await settle();
    expect(composeOnLines2to3(view)).toBe(true);
    await settle();

    const quote = view.contentDOM.querySelector(".tc-comment-quote");
    expect(quote?.textContent).toBe("two\nthree");
    expect(view.contentDOM.querySelector(".tc-comment-loc")?.textContent).toContain("lines 2–3");
  });

  it("captures the exact selection, partial lines included", async () => {
    // Whole-line widening would send the agent code the user did not point at,
    // and show them a snippet that isn't the one they highlighted.
    const view = mount(EDITOR_SURFACE);
    await settle();
    view.dispatch({ selection: {
      anchor: view.state.doc.line(2).from + 1,   // "wo"
      head: view.state.doc.line(3).from + 3,     // "thr"
    } });
    dispatchSelectionComment(view);
    await settle();

    expect(view.contentDOM.querySelector(".tc-comment-quote")?.textContent).toBe("wo\nthr");
    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    // Stored verbatim, with the line range that locates it.
    expect(useReviewComments.getState().byTask[TASK][0])
      .toMatchObject({ quote: "wo\nthr", startLine: 2, endLine: 3 });
  });

  it("omits the snippet for a whole-file comment", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    dispatchFileComment(view);
    await settle();
    expect(view.contentDOM.querySelector(".tc-comment-quote")).toBeNull();
  });

  it("tags a queued comment with the surface it was made on", async () => {
    for (const [surface, source] of [[EDITOR_SURFACE, "editor"], [undefined, "diff"]] as const) {
      useReviewComments.getState().clear(TASK);
      const view = mount(surface);
      await settle();
      composeOnLines2to3(view);
      await settle();

      const ta = view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!;
      ta.value = "look";
      view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();

      const queued = useReviewComments.getState().byTask[TASK];
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ source, quote: "two\nthree", startLine: 2, endLine: 3 });
    }
  });

  it("queues a selection with no comment written on it", async () => {
    // "Look at this" is a whole thought. Bouncing focus back to an empty box
    // made the selection un-queueable without inventing something to say.
    const view = mount(EDITOR_SURFACE);
    await settle();
    composeOnLines2to3(view);
    await settle();

    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    await settle();

    const queued = useReviewComments.getState().byTask[TASK];
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toBe("");
    // The composer closed, and the card that replaced it says what it holds
    // rather than rendering as an empty box.
    expect(view.contentDOM.querySelector(".tc-comment-textarea")).toBeNull();
    expect(view.contentDOM.querySelector(".tc-comment-card")?.textContent).toContain("Selection only");
  });

  it("still refuses an empty whole-file comment, which would say nothing", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    dispatchFileComment(view);
    await settle();

    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    await settle();

    expect(useReviewComments.getState().byTask[TASK] ?? []).toHaveLength(0);
    expect(view.contentDOM.querySelector(".tc-comment-textarea")).toBeTruthy();
  });
});

describe("selection gutter", () => {
  it("floats over the line numbers instead of widening the editor", () => {
    // A column that appears when you select and vanishes when you don't would
    // shove every line sideways mid-selection. Float mode is what prevents it,
    // and only the diff pane (button on every hovered line) keeps a real column.
    const editor = mount(EDITOR_SURFACE);
    const diff = mount();
    const gutterOf = (v: EditorView) => v.dom.querySelector(".tc-comment-gutter")!;
    expect(gutterOf(editor).classList.contains("tc-comment-gutter-float")).toBe(true);
    expect(gutterOf(diff).classList.contains("tc-comment-gutter-float")).toBe(false);
  });

  it("labels the button on hover with no browser delay, and cleans up after itself", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(2).to } });
    await settle();

    const btn = view.dom.querySelector<HTMLElement>(".tc-line-add-btn");
    expect(btn, "no comment button for a standing selection").toBeTruthy();
    // `title` would be the browser's tooltip: ~1s of stillness, by which point
    // the selection this button belongs to is usually gone.
    expect(btn!.hasAttribute("title")).toBe(false);
    expect(btn!.getAttribute("aria-label")).toBe("Send selection to agent");

    btn!.dispatchEvent(new Event("mouseenter"));
    expect(view.dom.querySelector(".tc-instant-tip")?.textContent).toBe("Send selection to agent");

    btn!.dispatchEvent(new Event("mouseleave"));
    expect(view.dom.querySelector(".tc-instant-tip")).toBeNull();

    // A tip left open when the button is torn down (selection cleared, editor
    // closed) would hang over the code with nothing to dismiss it.
    btn!.dispatchEvent(new Event("mouseenter"));
    view.dispatch({ selection: { anchor: 0 } });
    await settle();
    expect(view.dom.querySelector(".tc-instant-tip")).toBeNull();
  });
});
