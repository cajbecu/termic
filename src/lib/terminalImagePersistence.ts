import type { Terminal } from "@xterm/xterm";

type ImageAttr = { imageId?: number };
type ImageLine = { _data: Uint32Array; _extendedAttrs: Record<number, ImageAttr | undefined> };
type InputHandler = {
  _activeBuffer: { x: number; y: number; ybase: number; lines: { get(index: number): ImageLine | undefined } };
  eraseInLine(params: { params: ArrayLike<number> }, respectProtect?: boolean): boolean;
};

/** Preserve IIP cells through Pi's alternate-screen full-line redraw. */
export function preserveImagesOnErase(term: Terminal): { dispose(): void } {
  const input = (term as unknown as { _core: { _inputHandler: InputHandler } })._core._inputHandler;
  const original = input.eraseInLine;
  const eraseInLine = original.bind(input);
  let refreshStart = Infinity;
  let refreshEnd = -1;
  let frame1 = 0;
  let frame2 = 0;

  const scheduleRefresh = (row: number) => {
    refreshStart = Math.min(refreshStart, row);
    refreshEnd = Math.max(refreshEnd, row);
    if (frame1) return;
    frame1 = requestAnimationFrame(() => {
      frame1 = 0;
      frame2 = requestAnimationFrame(() => {
        frame2 = 0;
        if (refreshEnd < 0) return;
        const start = refreshStart;
        const end = refreshEnd;
        refreshStart = Infinity;
        refreshEnd = -1;
        term.refresh(start, end);
      });
    });
  };

  const wrapped: InputHandler["eraseInLine"] = (params, respectProtect) => {
    if (term.buffer.active.type !== "alternate" || params.params[0] !== 2 || input._activeBuffer.x !== 0)
      return eraseInLine(params, respectProtect);

    const row = input._activeBuffer.y;
    const line = input._activeBuffer.lines.get(input._activeBuffer.ybase + row);
    if (!line) return eraseInLine(params, respectProtect);

    const images: [number, number, ImageAttr][] = [];
    for (let x = 0; x < term.cols; x++) {
      const attr = line._extendedAttrs[x];
      if (attr?.imageId !== undefined && attr.imageId !== -1)
        images.push([x, line._data[x * 3 + 2], attr]);
    }

    const result = eraseInLine(params, respectProtect);
    for (const [x, bg, attr] of images) {
      line._data[x * 3 + 2] = bg;
      line._extendedAttrs[x] = attr;
    }
    if (images.length) scheduleRefresh(row);
    return result;
  };
  input.eraseInLine = wrapped;

  return {
    dispose() {
      if (input.eraseInLine === wrapped) input.eraseInLine = original;
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    },
  };
}
