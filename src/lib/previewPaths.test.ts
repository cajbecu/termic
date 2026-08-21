import { describe, it, expect } from "vitest";
import { isSvgPath, keepsDisplayWhenHidden, previewKindForPath, svgDataUrl, taskPdfSrc } from "@/lib/previewPaths";

describe("previewKindForPath", () => {
  it("routes image extensions to \"image\"", () => {
    expect(previewKindForPath("shot.png")).toBe("image");
    expect(previewKindForPath("nested/dir/photo.JPG")).toBe("image");
    expect(previewKindForPath("icon.svg")).toBe("image");
  });

  it("routes .pdf to \"pdf\"", () => {
    expect(previewKindForPath("doc.pdf")).toBe("pdf");
    expect(previewKindForPath("Report.PDF")).toBe("pdf");
  });

  it("returns null for non-previewable and extension-less files", () => {
    expect(previewKindForPath("main.ts")).toBeNull();
    expect(previewKindForPath("README.md")).toBeNull();
    expect(previewKindForPath("Makefile")).toBeNull();
  });
});

describe("isSvgPath", () => {
  it("matches .svg regardless of case or depth", () => {
    expect(isSvgPath("icon.svg")).toBe(true);
    expect(isSvgPath("docs/termic-wordmark.SVG")).toBe(true);
  });

  it("does not match other images, or a name merely containing svg", () => {
    expect(isSvgPath("shot.png")).toBe(false);
    expect(isSvgPath("svg")).toBe(false);
    expect(isSvgPath("my.svg.png")).toBe(false);
    expect(isSvgPath("assets/svg/logo.png")).toBe(false);
  });

  it("still reports \"image\" from previewKindForPath", () => {
    // The two answer different questions and must not be collapsed:
    // previewKindForPath is hand-synced with the backend's base64 whitelist
    // (which SVG stays on, for the markdown preview and the SvgPane
    // fallback), isSvgPath is only about which pane TaskView mounts.
    expect(previewKindForPath("icon.svg")).toBe("image");
  });
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';

describe("svgDataUrl", () => {
  it("produces an image/svg+xml data URL the CSP already allows", () => {
    // img-src includes `data:`, so this needs no policy change. See
    // src/lib/cspGuard.test.ts, which pins the policy itself.
    expect(svgDataUrl(SVG).startsWith("data:image/svg+xml;utf8,")).toBe(true);
  });

  it("round-trips the source exactly", () => {
    const body = svgDataUrl(SVG).slice("data:image/svg+xml;utf8,".length);
    expect(decodeURIComponent(body)).toBe(SVG);
  });

  it("survives a non-Latin1 label, which base64 via btoa would not", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Привет café 日本</text></svg>';
    const body = svgDataUrl(svg).slice("data:image/svg+xml;utf8,".length);
    expect(decodeURIComponent(body)).toBe(svg);
  });

  it("escapes the characters that would truncate the URL", () => {
    // A `#hex` fill starts a fragment and `?`/`&` a query if left raw, both
    // of which are ordinary inside an SVG.
    const svg = '<svg fill="#ff0000" data-q="a?b&c"></svg>';
    const url = svgDataUrl(svg);
    expect(url).not.toContain("#");
    expect(url).not.toContain("?b");
    expect(decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length))).toBe(svg);
  });
});

describe("keepsDisplayWhenHidden", () => {
  it("exempts a PDF edit tab from display:none", () => {
    expect(keepsDisplayWhenHidden({ type: "edit", path: "docs/report.pdf" })).toBe(true);
  });

  it("does not exempt anything else", () => {
    // Terminals are the whole reason display:none is load-bearing.
    expect(keepsDisplayWhenHidden({ type: "terminal" })).toBe(false);
    // An <img> has no native state to lose.
    expect(keepsDisplayWhenHidden({ type: "edit", path: "shot.png" })).toBe(false);
    expect(keepsDisplayWhenHidden({ type: "edit", path: "src/main.ts" })).toBe(false);
    // A diff of a PDF renders text through DiffPane, not the native embed.
    expect(keepsDisplayWhenHidden({ type: "diff", path: "docs/report.pdf" })).toBe(false);
    expect(keepsDisplayWhenHidden({ type: "edit" })).toBe(false);
  });
});

describe("taskPdfSrc", () => {
  it("changes only when the fingerprint changes", () => {
    const a = taskPdfSrc("task-1", "docs/report.pdf", "1700:900");
    expect(taskPdfSrc("task-1", "docs/report.pdf", "1700:900")).toBe(a);
    expect(taskPdfSrc("task-1", "docs/report.pdf", "1800:912")).not.toBe(a);
  });

  it("encodes the id, the path and the fingerprint", () => {
    const src = taskPdfSrc("task 1/x", "my docs/a b.pdf", "17:9");
    expect(src).toBe("taskpdf://localhost/task%201%2Fx/my%20docs%2Fa%20b.pdf?v=17%3A9");
    // The handler splits on the first '/', so neither segment may contain a
    // raw one.
    expect(src.slice("taskpdf://localhost/".length).split("/")).toHaveLength(2);
  });
});
