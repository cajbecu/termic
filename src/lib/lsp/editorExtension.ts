// The CodeMirror side of code intelligence (GH #174).
//
// Mounted into EditorPane's own compartment, so arming or disarming a task
// never rebuilds the EditorView (a rebuild re-reads disk and destroys undo
// history). With code intelligence off, nothing here is imported at all: the
// module is behind a dynamic import, which also keeps `@codemirror/lsp-client`
// and its LSP types out of the app-start chunk.
//
// **Document lifecycle rides the pane's mount effect, deliberately.** The
// plan's trap is that `openPreviewTab` recycles a preview tab in place,
// mutating `tab.path` without ever firing a close, so a naive tab-diff leaks
// `didOpen`s and desyncs the server's model — which returns wrong answers
// rather than errors. EditorPane keys its mount effect on `srcKey` (the path,
// or the pad id) and destroys the view in its cleanup, so a recycled slot
// tears the plugin down and builds a new one: the close and the open are the
// same pair the user's own tab close would produce. Nothing else has to know.

import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  LSPPlugin,
  serverCompletion,
  hoverTooltips,
  signatureHelp,
} from "@codemirror/lsp-client";
import { acquireClient, fileUri } from "./host";
import { pullDiagnostics } from "./pullDiagnostics";
import { modClickNavigation, showUsages, goToRelated, goToDefinitionOrUsages } from "./modClick";
import { goBack, goForward } from "./navigate";
import { fileStructure, showFileStructure } from "./fileStructure";
import { usagesPopup } from "./usagesPopup";
import { lspLanguageId, lspServerFor } from "./languages";
import { bindingToCmKey } from "@/lib/shortcuts";
import { usePrefs } from "@/store/prefs";

/**
 * The code-navigation keymap, from the live bindings.
 *
 * A CodeMirror keymap rather than the window listener the other rebindable
 * shortcuts use, because these must fire ONLY while an editor has focus:
 * F12 in a terminal belongs to the terminal.
 */
function navKeymap() {
  const binds = usePrefs.getState().shortcuts;
  const entry = (
    id: "go-to-definition" | "find-usages" | "go-to-implementation"
      | "go-to-type-definition" | "file-structure",
    run: (view: EditorView) => void,
  ) => {
    const b = binds[id];
    // A binding a user cleared is a key they asked not to have.
    if (!b) return [];
    return [{
      key: bindingToCmKey(b),
      preventDefault: true,
      run: (view: EditorView) => { run(view); return true; },
    }];
  };
  return [
    // OUR go-to-definition, not the client's. Two reasons, and both are
    // invisible until you hit them: the client's command jumps without
    // recording anything, so Back has nothing to return to, and it lands in
    // the stub without the hop to the implementation. The keyboard and the
    // mouse must agree about what "go to definition" does.
    ...entry("go-to-definition", v => void goToDefinitionOrUsages(v, v.state.selection.main.head)),
    // OUR find-usages, not the client's: same answer, floated at the symbol
    // and resolved through a workspace that can read files nothing has open.
    ...entry("find-usages", v => void showUsages(v, v.state.selection.main.head)),
    // The other two jumps. Same request shape as definition, so they land
    // through the same path, stub hop included.
    ...entry("go-to-implementation",
      v => void goToRelated(v, v.state.selection.main.head, "implementation")),
    ...entry("go-to-type-definition",
      v => void goToRelated(v, v.state.selection.main.head, "typeDefinition")),
    // What is in this file, filterable. Opening an unfamiliar 2,500-line file
    // and scrolling to find out is the slowest thing a reader does.
    ...entry("file-structure", v => void showFileStructure(v)),
  ];
}

export interface CodeIntelTarget {
  /** The checkout whose index answers: the worktree, or the main repo. */
  root: string;
  /** Absolute path of the file in the editor. */
  absPath: string;
  /** CodeMirror registry name for the buffer ("TypeScript", "Python"). */
  registryName: string | null;
}

/**
 * Build the extension for one editor, or null when this buffer gets no
 * navigation (no server for the language, or none installed on this machine).
 *
 * The caller must call `release()` when the editor goes away: that is the
 * refcount the server's lifetime hangs on.
 */
export async function codeIntelExtension(
  target: CodeIntelTarget,
): Promise<{ extension: Extension; release: () => void } | null> {
  const server = lspServerFor(target.registryName);
  const languageId = lspLanguageId(target.registryName);
  if (!server || !languageId) return null;

  const { client, release } = acquireClient(target.root, server);
  const extension: Extension = [
    LSPPlugin.create(client, fileUri(target.absPath), languageId),
    // Completion from the SERVER, not from the words already in the buffer.
    // Without this the only source is `basicSetup`'s local word scraper, which
    // can offer `StorePage` because it is on screen and can never offer
    // `.objects` on it — the thing you actually wanted. It merges with the
    // local source rather than replacing it, so a scratch buffer still
    // completes its own words.
    serverCompletion(),
    hoverTooltips(),
    signatureHelp(),
    // Push diagnostics come through the client (fanned out to every view in
    // workspace.ts); this covers the servers that only answer when asked, and
    // TypeScript 7 is one of them.
    pullDiagnostics,
    // The keys, read from the USER's bindings rather than hard-coded.
    //
    // They were five literal strings here, which meant Settings -> Shortcuts
    // could not show them and could not change them: a reader who wanted
    // go-to-definition on a different key had nowhere to say so, and a reader
    // who did not know F12 existed had nowhere to find out. They are ordinary
    // entries in `SHORTCUT_DEFS` now, and this converts each to CodeMirror's
    // notation. A rebind takes effect on the next editor mount; the keymap is
    // built once per view and rebuilding it would cost an EditorView.
    keymap.of(navKeymap()),
    // ⌘-click: jump to the definition, or list the usages when you are
    // already standing on it. The second half is the JetBrains behaviour
    // people miss most, and it is one comparison away from the first.
    modClickNavigation,
    // The mouse's own back/forward buttons, which is how most people navigate
    // history when their hand is already on it.
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button === 3) { void goBack(view); return true; }
        if (event.button === 4) { void goForward(view); return true; }
        return false;
      },
    }),
    // The usages list floats at the symbol rather than docking under the
    // editor: your eye is already on the symbol, and a docked panel makes
    // every lookup a round trip across the pane.
    usagesPopup,
    fileStructure,
    // A server that dies (crash, OOM, a `cargo` that ate the machine) must not
    // leave the editor looking like it is still thinking. The plugin surfaces
    // its own errors; this keeps the pane usable regardless.
    EditorView.exceptionSink.of(err => console.warn("[lsp]", err)),
  ];
  return { extension, release };
}
