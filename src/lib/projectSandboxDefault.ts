// What cage a NEW task of a project gets when nobody chooses one per task.
//
// Three stored fields express one choice (`default_docker`, plus Seatbelt's
// `default_sandbox_mode` / `default_sandbox`), because Docker and Seatbelt are
// independent booleans on the record - see `SandboxSelection` in lib/types.ts.
// Every reader has to collapse them the SAME way or the app disagrees with
// itself about what a project's default is: the settings picker, the sidebar's
// quick-create note, and the task the quick path actually creates all come
// through here.

import type { Project, SandboxSelection } from "@/lib/types";

/** The project's default engine in the picker's own vocabulary. */
export function projectSandboxDefault(p: Project | null | undefined): SandboxSelection {
  if (!p) return "off";
  if (p.default_docker) return "docker";
  // `default_sandbox_mode` is the precise answer; the older boolean only says
  // "on", which has always meant Enforce.
  return (p.default_sandbox_mode as SandboxSelection | undefined)
    ?? (p.default_sandbox ? "enforce" : "off");
}

/** Union two lists preserving order, first occurrence wins. The same merge
 *  the New Task dialog does when it seeds its allow-lists. */
export function mergeLists(a: string[] = [], b: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}
