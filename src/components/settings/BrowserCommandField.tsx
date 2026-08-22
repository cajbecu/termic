// The "open links in" editor (GH #245). Shared by Settings → General (the
// app-wide setting) and Settings → Repositories (a project's override), so the
// preset list, the validation and the wording cannot drift between them.
//
// A dropdown of presets that WRITES INTO an editable text box, rather than a
// picker bound to a fixed list. Two reasons: the field holds a command, not an
// app name, so it can express things no list could ("Chrome, but my work
// profile"); and no detection scheme can enumerate every browser, so the text
// box is the escape hatch that makes the preset list a convenience instead of
// a limit.

import { useEffect, useRef, useState } from "react";
import { browserCommandCheck } from "@/lib/ipc";
import { browserPresets, type BrowserPreset } from "@/lib/previewBrowser";
import { Input } from "@/components/ui/Input";

/** Sentinel for the project-level "follow the app-wide setting" option, which
 *  is `undefined` in the data (see Project.preview_browser). */
const INHERIT = "__inherit__";
const CUSTOM = "__custom__";

const selectCls =
  "h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 " +
  "text-[13px] text-[var(--color-fg)] outline-none transition-colors " +
  "focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]";

export function BrowserCommandField({
  value, onChange, allowInherit = false, globalCommand = "", testId = "browser-command",
}: {
  /** `undefined` = inherit (project level only); `""` = OS default. */
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  /** Offer "Follow the app-wide setting". Project level only. */
  allowInherit?: boolean;
  /** The app-wide command, to describe what inheriting currently means. */
  globalCommand?: string;
  testId?: string;
}) {
  const presets = browserPresets();
  const [err, setErr] = useState<string | null>(null);
  // Which preset the dropdown shows. Derived from `value` on every render so
  // pasting a command that happens to equal a preset selects it, but held in
  // state too: picking "Custom" must not immediately snap back to a preset.
  const matched = presets.find(p => p.command === (value ?? ""));
  const [forceCustom, setForceCustom] = useState(false);
  const selected = value === undefined && allowInherit
    ? INHERIT
    : forceCustom || !matched ? CUSTOM : matched.command;

  // Validate the launcher, debounced. Only a non-empty command can be wrong:
  // empty means "OS default", and inherit means "not my problem".
  const cmd = value ?? "";
  const seq = useRef(0);
  useEffect(() => {
    if (!cmd.trim()) { setErr(null); return; }
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      browserCommandCheck(cmd)
        .then(() => { if (seq.current === mine) setErr(null); })
        .catch(e => { if (seq.current === mine) setErr(String(e)); });
    }, 400);
    return () => window.clearTimeout(t);
  }, [cmd]);

  function pick(v: string) {
    if (v === INHERIT) { setForceCustom(false); onChange(undefined); return; }
    if (v === CUSTOM) { setForceCustom(true); return; }
    setForceCustom(false);
    onChange(v);
  }

  const hint: BrowserPreset["hint"] = matched?.hint;
  const inheritLabel = globalCommand.trim()
    ? `Follow the app-wide setting (${globalCommand})`
    : "Follow the app-wide setting (system default)";

  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-md">
        <select
          value={selected}
          onChange={(e) => pick(e.target.value)}
          className={selectCls}
          data-testid={`${testId}-preset`}
          aria-label="Browser preset"
        >
          {allowInherit && <option value={INHERIT}>{inheritLabel}</option>}
          {presets.map(p => <option key={p.label} value={p.command}>{p.label}</option>)}
          <option value={CUSTOM}>Custom command…</option>
        </select>
      </div>

      {/* Hidden only while inheriting: there is nothing of this project's own
          to edit then, and showing an empty box would read as "no browser". */}
      {value !== undefined && (
        <>
          <Input
            value={value}
            onChange={(e) => { setForceCustom(true); onChange(e.target.value); }}
            placeholder="Leave empty for your system default browser"
            className="font-mono"
            spellCheck={false}
            data-testid={`${testId}-input`}
            aria-label="Browser command"
          />
          {err && (
            <div className="text-[12px] text-[var(--color-err)]" data-testid={`${testId}-error`}>
              {err}
            </div>
          )}
          {!err && hint && (
            <div className="text-[12px] text-[var(--color-fg-dim)]">{hint}</div>
          )}
          {!err && !hint && (
            <div className="text-[12px] text-[var(--color-fg-dim)]">
              The URL is added to the end of the command. Use <code className="font-mono">{"{url}"}</code> to put it somewhere else.
            </div>
          )}
        </>
      )}
    </div>
  );
}
