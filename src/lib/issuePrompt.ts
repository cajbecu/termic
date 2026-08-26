// Turning a forge issue into a task: the branch name, the task name, and the
// prompt the agent wakes up holding.
//
// The prompt is composed, not stored: the ISSUE half (title, number, link,
// body, and the command to fetch the thread) is generated here, and the
// INSTRUCTION half is `builtin:work-issue` from the prompt library. That split
// is the point - a user who edits "Work on the issue" in the library changes
// how every future issue task behaves, without us having to template their
// text or re-derive it per provider.

import type { ForgeIssue } from "@/lib/types";
import { usePromptLibrary } from "@/store/prompts";
import { WORK_ISSUE_PROMPT } from "@/lib/builtinPrompts";
import { slugify, branchify } from "@/lib/utils";

/** How much issue body we inline. Long issues exist (design docs pasted into
 *  a description); past a few thousand characters the agent is better served
 *  by the link and the fetch command than by the whole wall of text, and the
 *  first part is where the actual ask lives. */
const BODY_MAX = 4000;

/** `#123` on GitHub, `#123` on GitLab too (GitLab writes issues as #, and
 *  reserves ! for merge requests - unlike the MR case this is NOT a
 *  per-provider difference). */
export function issueRef(issue: Pick<ForgeIssue, "number">): string {
  return `#${issue.number}`;
}

/** The CLI command that dumps the issue with its full comment thread. The
 *  agent runs this itself rather than us shipping the thread in the prompt. */
export function issueFetchCommand(issue: Pick<ForgeIssue, "provider" | "number">): string {
  return issue.provider === "gitlab"
    ? `glab issue view ${issue.number} --comments`
    : `gh issue view ${issue.number} --comments`;
}

/** Task name: `#123 Fix the thing`, trimmed to something a sidebar row can
 *  show. The number leads so a row is identifiable when the title truncates. */
export function issueTaskName(issue: Pick<ForgeIssue, "number" | "title">, max = 60): string {
  const ref = `#${issue.number}`;
  const title = issue.title.trim();
  if (!title) return ref;
  const full = `${ref} ${title}`;
  return full.length <= max ? full : `${full.slice(0, max - 1).trimEnd()}…`;
}

/** Branch: `<prefix>/issue-123-fix-the-thing`. The number is in there so the
 *  branch is traceable back to the issue after the title has been forgotten,
 *  and a title that slugifies to nothing still yields a valid branch. */
export function issueBranch(
  issue: Pick<ForgeIssue, "number" | "title">,
  branchPrefix: string,
  maxSlugWords = 6,
): string {
  const words = slugify(issue.title).split("-").filter(Boolean).slice(0, maxSlugWords);
  const stem = ["issue", String(issue.number), ...words].join("-");
  const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
  return branchify(prefix ? `${prefix}/${stem}` : stem);
}

/** The issue half of the prompt: identity, link, body, and how to read the
 *  discussion. Exported separately so tests can assert it without depending
 *  on the prompt library's state. */
export function issueContext(issue: ForgeIssue): string {
  const host = issue.provider === "gitlab" ? "GitLab" : "GitHub";
  const body = issue.body.trim();
  const truncated = body.length > BODY_MAX;
  const shown = truncated ? `${body.slice(0, BODY_MAX).trimEnd()}\n\n[body truncated, read the rest with the command below]` : body;
  const lines = [
    `${host} issue ${issueRef(issue)}: ${issue.title.trim()}`,
    issue.url,
  ];
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.join(", ")}`);
  lines.push("");
  lines.push(shown || "(The issue has no description. The discussion is all there is.)");
  lines.push("");
  lines.push(
    issue.comments > 0
      ? `This issue has ${issue.comments} comment${issue.comments === 1 ? "" : "s"}, which are NOT included above. Read them with \`${issueFetchCommand(issue)}\`.`
      : `It has no comments yet. Confirm with \`${issueFetchCommand(issue)}\` before assuming the description is the whole story.`,
  );
  return lines.join("\n");
}

/** The full prompt seeded into a fresh issue task: issue context, then the
 *  user's (or default) "Work on the issue" instructions. Reads the library
 *  live so an edited or disabled builtin is respected; falls back to the
 *  shipped text if the user deleted it outright, because a task created from
 *  an issue with no instructions at all would just be a wall of context. */
export function buildIssuePrompt(issue: ForgeIssue): string {
  const prompt = usePromptLibrary.getState().prompts.find(p => p.id === "builtin:work-issue");
  const instructions = (prompt?.body ?? WORK_ISSUE_PROMPT).trim();
  return `${issueContext(issue)}\n\n---\n\n${instructions}`;
}
