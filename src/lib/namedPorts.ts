// Extra named ports (GH #196): name validation shared by the Repo
// Settings editor (inline warnings) and tests. MIRRORS the Rust
// source of truth (`valid_port_name` / RESERVED_PORT_NAMES in
// src-tauri/src/lib.rs); keep the two lists in sync.

export const RESERVED_PORT_NAMES: ReadonlySet<string> = new Set([
  "TERMIC_PORT", "TERMIC_TASK", "TERMIC_TASK_ID", "TERMIC_WORKSPACE_NAME",
  "TERMIC_CLI", "CONDUCTOR_PORT", "CONDUCTOR_WORKSPACE_NAME",
  "PATH", "HOME", "SHELL", "USER", "TMPDIR", "PWD", "TERM", "LANG", "COLORFGBG",
]);

/** A usable extra-named-port env var name: `[A-Za-z_][A-Za-z0-9_]*`
 *  and not reserved. Names are used verbatim (free text, no case
 *  transformation). */
export function isValidPortName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_PORT_NAMES.has(name);
}
