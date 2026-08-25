// The shape of the file you are looking at (GH #174).
//
// IntelliJ's ⌘F12. Opening an unfamiliar 2,500-line file and scrolling to
// learn what is in it is the slowest thing a reader does; an outline answers
// it in one keystroke, and typing filters it.
//
// `textDocument/documentSymbol` returns either a flat list (SymbolInformation,
// the old shape) or a tree (DocumentSymbol, the current one). Servers still
// disagree about which — ty and rust-analyzer answer the tree, some answer the
// flat list — so both are flattened here rather than at each call site.

import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";
import { gotoLocation } from "@/lib/gotoLocation";
import { currentPoint, navigateTo, pointFor, taskForPath } from "./navigate";
import { uriToPath } from "./workspace";
import { useApp } from "@/store/app";

/** LSP's SymbolKind, as the names a reader recognises. Trimmed to the ones a
 *  file outline actually contains. */
const KIND_LABEL: Record<number, string> = {
  2: "module", 5: "class", 6: "method", 7: "property", 8: "field",
  9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable",
  14: "constant", 22: "struct", 23: "event", 26: "type",
};

export interface OutlineRow {
  name: string;
  kind: string;
  /** 1-based. */
  line: number;
  /** How deep in the tree, for indentation. */
  depth: number;
  /** The enclosing symbol, so a filtered list still says where a method is. */
  parent?: string;
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range?: { start: { line: number } };
  selectionRange?: { start: { line: number } };
  location?: { range: { start: { line: number } } };
  children?: DocumentSymbol[];
  containerName?: string;
}

/** Flatten whichever shape the server sent into rows a list can render. */
export function flattenSymbols(
  symbols: DocumentSymbol[] | null | undefined,
  depth = 0,
  parent?: string,
): OutlineRow[] {
  if (!symbols?.length) return [];
  const out: OutlineRow[] = [];
  for (const sym of symbols) {
    const start = sym.selectionRange?.start ?? sym.range?.start ?? sym.location?.range.start;
    if (!start) continue;
    out.push({
      name: sym.name,
      kind: KIND_LABEL[sym.kind] ?? "symbol",
      line: start.line + 1,
      depth,
      // The flat shape carries the parent as `containerName`; the tree shape
      // carries it in the nesting, so it is passed down.
      parent: parent ?? sym.containerName ?? undefined,
    });
    out.push(...flattenSymbols(sym.children, depth + 1, sym.name));
  }
  return out;
}

/** Subsequence match, the same rule the file finder uses, so filtering an
 *  outline feels like filtering anything else in the app. */
export function filterOutline(rows: OutlineRow[], query: string): OutlineRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const scored: Array<{ row: OutlineRow; score: number }> = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    if (name.startsWith(q)) { scored.push({ row, score: 0 }); continue; }
    const i = name.indexOf(q);
    if (i > 0) { scored.push({ row, score: 1 + i / 100 }); continue; }
    // Subsequence: "sps" finds "StorePageSerializer".
    let at = 0;
    let ok = true;
    for (const ch of q) {
      at = name.indexOf(ch, at);
      if (at < 0) { ok = false; break; }
      at++;
    }
    if (ok) scored.push({ row, score: 2 });
  }
  return scored.sort((a, b) => a.score - b.score).map(s => s.row);
}

export const setOutline = StateEffect.define<OutlineRow[] | null>();
const setOutlineQuery = StateEffect.define<string>();
const moveOutline = StateEffect.define<number>();

interface OutlineState { rows: OutlineRow[]; query: string; active: number; pos: number }

const outlineField = StateField.define<OutlineState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setOutline)) {
        return e.value
          ? { rows: e.value, query: "", active: 0, pos: tr.state.selection.main.head }
          : null;
      }
      if (e.is(setOutlineQuery) && value) return { ...value, query: e.value, active: 0 };
      if (e.is(moveOutline) && value) {
        const shown = filterOutline(value.rows, value.query);
        const next = Math.max(0, Math.min(shown.length - 1, value.active + e.value));
        return { ...value, active: next };
      }
    }
    if (tr.docChanged && value) return null;
    return value;
  },
  provide: f => showTooltip.from(f, s => (s ? buildOutline(s) : null)),
});

function buildOutline(state: OutlineState): Tooltip {
  return {
    pos: state.pos,
    above: false,
    arrow: true,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-outline";

      const input = dom.appendChild(document.createElement("input"));
      input.className = "cm-lsp-outline-input";
      input.placeholder = "Filter symbols";
      input.spellcheck = false;

      const list = dom.appendChild(document.createElement("div"));
      list.className = "cm-lsp-outline-list";

      const render = () => {
        const shown = filterOutline(state.rows, state.query);
        list.textContent = "";
        if (!shown.length) {
          const empty = list.appendChild(document.createElement("div"));
          empty.className = "cm-lsp-outline-empty";
          empty.textContent = "No symbols match";
          return;
        }
        shown.forEach((row, i) => {
          const entry = list.appendChild(document.createElement("div"));
          entry.className = "cm-lsp-outline-row";
          if (i === state.active) entry.classList.add("cm-lsp-outline-active");
          // Indentation carries the nesting, which is how you read a class's
          // methods as belonging to it rather than as more top-level names.
          entry.style.paddingLeft = `${8 + (state.query ? 0 : row.depth * 12)}px`;
          const kind = entry.appendChild(document.createElement("span"));
          kind.className = "cm-lsp-outline-kind";
          kind.textContent = row.kind;
          const name = entry.appendChild(document.createElement("span"));
          name.className = "cm-lsp-outline-name";
          name.textContent = row.name;
          // A filtered list has lost the indentation's meaning, so the parent
          // is spelled out instead.
          if (state.query && row.parent) {
            const parent = entry.appendChild(document.createElement("span"));
            parent.className = "cm-lsp-outline-parent";
            parent.textContent = row.parent;
          }
          const num = entry.appendChild(document.createElement("span"));
          num.className = "cm-lsp-outline-line";
          num.textContent = String(row.line);
          entry.addEventListener("mousedown", (e) => {
            e.preventDefault();
            void jumpToRow(view, row);
          });
          if (i === state.active) entry.scrollIntoView({ block: "nearest" });
        });
      };
      render();

      input.addEventListener("input", () => {
        state.query = input.value;
        state.active = 0;
        render();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { view.dispatch({ effects: setOutline.of(null) }); view.focus(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const shown = filterOutline(state.rows, state.query);
          state.active = Math.max(0, Math.min(shown.length - 1, state.active + (e.key === "ArrowDown" ? 1 : -1)));
          render();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const row = filterOutline(state.rows, state.query)[state.active];
          if (row) void jumpToRow(view, row);
        }
      });
      // The filter is the point of the popup, so it takes focus. A timer, not
      // rAF: rAF is frozen while the window is occluded (docs/gotchas.md).
      setTimeout(() => input.focus(), 0);
      return { dom };
    },
  };
}

async function jumpToRow(view: EditorView, row: OutlineRow): Promise<void> {
  view.dispatch({ effects: setOutline.of(null) });
  const plugin = LSPPlugin.get(view);
  const abs = plugin ? uriToPath(plugin.uri) : null;
  const task = abs ? taskForPath(abs) : null;
  if (!abs || !task) {
    gotoLocation(view, row.line);
    return;
  }
  // Same file, but still a JUMP: Back has to return you to where you were
  // reading before you used the outline.
  await navigateTo(view, pointFor(task.id, task.path, abs, row.line), currentPoint(view));
  view.focus();
}

/** Ask the server for this file's symbols and show them. */
export async function showFileStructure(view: EditorView): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const client = plugin.client;
  // A server that failed to spawn rejects here; a ⌘-click must not become an
  // unhandled rejection, and the caller has nothing useful to do with it.
  try { await client.initializing; } catch { return; }
  if (!client.serverCapabilities?.documentSymbolProvider) return;
  client.sync();
  let symbols: DocumentSymbol[] | null = null;
  try {
    symbols = await client.request<unknown, DocumentSymbol[] | null>("textDocument/documentSymbol", {
      textDocument: { uri: plugin.uri },
    });
  } catch {
    return;
  }
  const rows = flattenSymbols(symbols);
  if (rows.length) view.dispatch({ effects: setOutline.of(rows) });
}

export const fileStructure: Extension = [outlineField];
