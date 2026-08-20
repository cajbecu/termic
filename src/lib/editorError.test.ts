import { describe, it, expect } from "vitest";
import { BINARY_NOTICE, classifyEditorLoadError } from "./editorError";

// The rule this pins: binary is a wrong-viewer state (calm notice + OS
// actions), everything else is a real failure (raw message, red). Get it
// backwards and either a spreadsheet looks like a crash, or a permission
// error offers an "Open in default app" button that fails again.

describe("classifyEditorLoadError", () => {
  it("treats the Rust UTF-8 rejection as binary and replaces the message", () => {
    // The exact string src-tauri/src/lib.rs returns from task_file_read.
    const e = classifyEditorLoadError("file is not valid UTF-8");
    expect(e.kind).toBe("binary");
    expect(e.message).toBe(BINARY_NOTICE);
  });

  it("matches loosely enough to survive a reword on the Rust side", () => {
    for (const msg of ["invalid UTF-8", "not VALID utf-8 text", "Error: file is not valid UTF-8"])
      expect(classifyEditorLoadError(msg).kind).toBe("binary");
  });

  it("keeps a genuine failure raw, verbatim", () => {
    const e = classifyEditorLoadError("No such file or directory (os error 2)");
    expect(e.kind).toBe("raw");
    expect(e.message).toBe("No such file or directory (os error 2)");
  });

  it("does not mistake an unrelated encoding error for binary", () => {
    expect(classifyEditorLoadError("file exceeds the 2 MB read cap").kind).toBe("raw");
    expect(classifyEditorLoadError("permission denied").kind).toBe("raw");
  });

  it("stringifies whatever the IPC layer rejected with", () => {
    expect(classifyEditorLoadError(new Error("file is not valid UTF-8")).kind).toBe("binary");
    expect(classifyEditorLoadError(new Error("no task")).message).toBe("Error: no task");
  });
});
