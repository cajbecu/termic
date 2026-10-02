import { useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Terminal } from "@xterm/xterm";
import { ClipboardPaste, Copy, TextSelect } from "lucide-react";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/ContextMenu";

/** Right-click menu for a terminal: copy, paste, select all.
 *
 *  The keyboard already does all three, but the bindings differ per platform
 *  (Ctrl+Shift+C on Windows and Linux, because plain Ctrl+C is the shell's)
 *  and a menu is where someone looks when the one they tried did nothing.
 *
 *  Wraps the xterm host element. A paste goes through `term.paste`, as the
 *  key handlers in TerminalPane / AuxTerminal do, so it reaches the PTY
 *  exactly as a keyboard paste does (bracketed when the program asked for
 *  it).
 *
 *  The clipboard itself goes through the Rust plugin, not navigator.clipboard,
 *  for the reason lib/clipboard.ts gives: the web API wants a user gesture and
 *  a focused document, and a Radix menu's onSelect carries neither in
 *  WKWebView. The web API stays as the fallback. */
export function TerminalContextMenu({ termRef, children }: {
  termRef: RefObject<Terminal | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation("task");
  // Read when the menu opens, not on every selection change: xterm fires
  // those per mouse move while dragging, and nothing shows this until then.
  const [hasSelection, setHasSelection] = useState(false);

  // The menu takes focus while it is open, so hand it back: the next thing
  // the user does after a paste is type.
  const act = (fn: (term: Terminal) => void) => () => {
    const term = termRef.current;
    if (!term) return;
    fn(term);
    setTimeout(() => termRef.current?.focus(), 0);
  };

  return (
    <ContextMenuRoot onOpenChange={(open) => {
      if (open) setHasSelection(!!termRef.current?.hasSelection());
    }}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <div data-testid="terminal-context-menu">
          <ContextMenuItem
            disabled={!hasSelection}
            onSelect={act(term => {
              const text = term.getSelection();
              writeText(text).catch(() => navigator.clipboard.writeText(text)).catch(() => {});
            })}
          >
            <Copy />{t("terminal.menuCopy")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={act(term => {
              readText().catch(() => navigator.clipboard.readText())
                .then(text => { if (text) term.paste(text); })
                .catch(() => {});
            })}
          >
            <ClipboardPaste />{t("terminal.menuPaste")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={act(term => term.selectAll())}>
            <TextSelect />{t("terminal.menuSelectAll")}
          </ContextMenuItem>
        </div>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
