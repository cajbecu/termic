// Last-used per-member task mode for the multi-repo New Task dialog.
//
// The single-repo dialog remembers one global mode (`newTaskLastMode`) because
// that choice is about how the user works. Member modes are different: they are
// about the REPO ("this library is always safe to worktree, that config repo I
// always run live"), so they are remembered per member root_path, globally
// across projects — the same member added to two multi projects keeps one
// preference. Kept in its own module (not NewTaskDialog.tsx) so vitest can
// import it without executing the dialog's DOM code.

export type MemberTaskMode = "worktree" | "repo_root";

export const LS_MEMBER_MODES = "newTaskMemberModes";

/** The remembered map, `{ [root_path]: mode }`. Unknown values and a corrupt
 *  blob both come back as "nothing remembered" — a bad entry must never wedge
 *  the dialog. */
export function readMemberModes(): Record<string, MemberTaskMode> {
  try {
    const raw = localStorage.getItem(LS_MEMBER_MODES);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, MemberTaskMode> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "worktree" || v === "repo_root") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write through one member's choice. Merges into the stored map so two multi
 *  projects don't clobber each other's members. */
export function persistMemberMode(rootPath: string, mode: MemberTaskMode) {
  try {
    localStorage.setItem(
      LS_MEMBER_MODES,
      JSON.stringify({ ...readMemberModes(), [rootPath]: mode }),
    );
  } catch {
    // Storage full / unavailable: the dialog still works, it just won't
    // remember. Same silent policy as persistLast in NewTaskDialog.
  }
}

/** The mode a member row seeds with: the hard constraint first (non-git has no
 *  branches, so worktree is impossible), then the remembered choice, then the
 *  historical default (worktree — the safe, isolated shape). */
export function seedMemberMode(
  nonGit: boolean,
  remembered: Record<string, MemberTaskMode>,
  rootPath: string,
): MemberTaskMode {
  if (nonGit) return "repo_root";
  return remembered[rootPath] ?? "worktree";
}
