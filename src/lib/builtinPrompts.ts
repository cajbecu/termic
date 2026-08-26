// Built-in prompt bodies for the prompt library (src/store/prompts.ts), in the
// same voice as the Review prompt (lib/review.ts). All diff-aware prompts open
// with the same way to see the worktree changes via plain git. User-visible
// text, so no em dashes.

// Shared preamble so every diff-aware prompt finds the changes the same way.
// A branch's changes = committed diff vs the base branch + uncommitted work.
const SEE_CHANGES =
  "To see what changed, run `git diff HEAD` (uncommitted) and, for the committed " +
  "work on this branch, `git diff $(git merge-base origin/main HEAD 2>/dev/null " +
  "|| git merge-base main HEAD) HEAD`. Use `git status --short` for untracked files.";

export const WRITE_TESTS_PROMPT = `# Write tests

Add tests for the changes in this branch.

${SEE_CHANGES}

Then:
1. Match the project's existing test framework, file layout, and naming. Read a nearby test file before writing a new one.
2. Test BEHAVIOR through the public interface, not implementation details. Prefer integration-style tests over mock-heavy unit tests; a test that only exercises its own mocks proves nothing.
3. Cover the new and changed behavior, plus the edge cases that matter: empty input, missing or null values, error and failure paths, and boundaries.
4. Keep each test focused and readable. Prefer clear, specific assertions over broad snapshots.
5. Run the test suite and make your new tests pass. Do not weaken an assertion or skip a case just to get a green run. Fix the code or the test honestly, and if a change is a real bug, say so.

If something is not meaningfully testable (pure formatting, comments, generated files), say so instead of padding with trivial tests.`;

export const SECURITY_REVIEW_PROMPT = `# Security review

Audit the changes in this branch for security issues.

${SEE_CHANGES}

Look specifically for:
- Injection: SQL, command, path, or template injection from unsanitized input.
- Secrets: hardcoded credentials, API keys, tokens, or private keys.
- AuthN / AuthZ: missing or incorrect authentication and authorization checks on new endpoints or actions.
- Unsafe input handling: missing validation, unsafe deserialization, SSRF, open redirects, XSS.
- Crypto and randomness: weak algorithms or predictable values used where security matters.
- New dependencies: anything added to lockfiles or manifests; check for typosquats, unpinned versions, and install scripts.
- Unwanted egress: new network calls to hosts the project did not already talk to.

For each finding, give the file and line, a severity (low, medium, high, or critical), the concrete scenario an attacker would use, and a specific fix. Flag only real, exploitable issues introduced or exposed by these changes, not theoretical or style concerns. If you find nothing, say so plainly.`;

export const EXPLAIN_CHANGES_PROMPT = `# Explain the changes

Summarize the changes in this branch for a teammate who is about to review them.

${SEE_CHANGES}

Produce:
1. A two or three sentence high-level summary: what changed and why.
2. A bullet list of the notable changes, grouped by area or file, in plain language (not a line-by-line diff readout).
3. A short "Worth a closer look" note for anything risky, surprising, or that needs a decision.

Keep it concise and skimmable. Do not restate the obvious or pad the summary.`;

export const COMMIT_PROMPT = `# Commit

Commit the current changes.

1. Run \`git status\` and \`git diff\` (and \`git diff --staged\`) to see everything that changed.
2. Stage the changes that belong together. If the working tree mixes unrelated changes, make separate commits rather than one catch-all.
3. Write a Conventional Commits message: a \`type(scope): summary\` subject, where type is one of feat, fix, refactor, docs, test, chore, or perf, with an accurate scope, kept under about 72 characters, and a body that explains the why, not the what.
4. Do not commit scratch files, debug output, secrets, or unrelated edits. Leave those out and mention them.
5. Never pass \`--no-verify\` or \`--no-gpg-sign\`, and never amend or rewrite commits that already exist, unless explicitly told to. If a hook blocks the commit, stop and report the hook's output instead of working around it.

Finish by showing \`git log -1\` for what you committed.`;

export const COMMIT_PUSH_PROMPT = `# Commit and push

Commit the current changes and push the branch.

1. Run \`git status\` and \`git diff\` (and \`git diff --staged\`) to see everything that changed.
2. Stage what belongs together; split unrelated changes into separate commits. Write Conventional Commits messages (\`type(scope): summary\`, body explains the why).
3. Do not commit scratch files, debug output, secrets, or unrelated edits. Never pass \`--no-verify\` or \`--no-gpg-sign\`. If a hook blocks the commit, stop and report its output.
4. Push the current branch to its remote (\`git push\`, or \`git push -u origin <branch>\` for a new branch). Never force-push, and never push to a branch other than the current one.
5. If the push is rejected, report the exact error and stop. Do not rebase, force, or delete anything to make it go through.

Finish by showing \`git log -1\` and the push result.`;

export const VERIFY_PROMPT = `# Verify end to end

Verify that the current changes actually work by running them, not by reading the diff.

${SEE_CHANGES}

Then:
1. Run the project's checks: typecheck, lint, and the test suite. Report exact commands and exit codes.
2. Exercise the changed behavior for real: start the app or service, hit the endpoint with real inputs, run the CLI end to end, or drive the UI flow that changed. Check logs and console for errors while doing it.
3. Reading the diff is not verification, and "it compiles" is not verification. If a step cannot be exercised from here (needs hardware, credentials, or a human eye), say exactly which step and why.

End with one verdict line per claim: [tested] ran it end to end and saw it work, [smoke-passed] checks pass but the behavior was not exercised, or [untested] with what is missing. Never imply something works without saying which of these it is.`;

export const FIX_BUG_PROMPT = `# Fix the bug (reproduce first)

Fix the bug I describe next (or the failure visible in the current output), with reproduction as the first step.

1. REPRODUCE it first: find the exact command, input, or flow that triggers it, run it, and show the failing output. If you cannot reproduce it, stop and say what you tried and what input you need. Never fix from the description alone.
2. Find the root cause, not the symptom. If a fix would just patch over an earlier bad fix, name the underlying cause and fix that instead.
3. Make the smallest fix that resolves the root cause. A bug fix stays a bug fix: no drive-by refactors, renames, or features.
4. Re-run the reproduction from step 1 and show it passing. Run the test suite to catch regressions.
5. Add a regression test that fails without the fix, if the project has a test setup where that is natural.

Report: the repro, the root cause, the fix, and the passing rerun.`;

export const STATUS_PROMPT = `# What is the state?

Orient me in this workspace right now. Do not change anything.

Report, concretely:
1. Branch and git state: current branch, how far from the base branch, uncommitted or untracked files (\`git status --short\`), and the last few commits (\`git log --oneline -5\`).
2. Whether the project currently builds and passes its checks: run the cheapest ones (typecheck, quick tests) and report exit codes.
3. Any work that looks in flight: TODO or FIXME added on this branch, half-wired code, failing tests, uncommitted experiments.
4. The next 2 or 3 obvious moves, each in one line, based on what you found, not speculation.

Keep it short and factual. If something is unknowable from here, say so instead of guessing.`;

export const UPDATE_DOCS_PROMPT = `# Update the docs

Bring the project's documentation in line with what actually changed on this branch.

${SEE_CHANGES}

Then:
1. Find the docs that describe the changed behavior: README, docs/, CHANGELOG if the project keeps one, agent instruction files (CLAUDE.md, AGENTS.md), inline usage examples, and command or flag references.
2. Update only what the changes made stale: renamed commands, changed flags or defaults, new or removed features, changed setup steps. Verify each claim against the code before writing it.
3. Do not invent promises, roadmaps, or features that do not exist, and do not pad with marketing language. Write plainly.
4. If the docs and the code disagree in a way you cannot resolve, flag the conflict instead of picking a side silently.

Show the doc diff at the end.`;

export const RESEARCH_PROMPT = `# Research before answering

For the question I ask next, verify against current sources before answering. Do not answer from memory.

1. If you have web access, search for the specific claim, version, pairing, or price in question and read the primary source (official docs, changelog, repo). If you have no web access, say so up front and clearly mark everything that follows as unverified.
2. Verify the SPECIFIC pairing or version asked about, not a neighboring fact that feels similar. APIs, prices, model names, and defaults change; the feeling of already knowing is exactly when to check.
3. Separate the answer into what is verified (with the source) and what is inference. Never present inference as fact.
4. If sources disagree or the answer is genuinely unsettled, say that plainly instead of picking the most confident-sounding version.`;

export const CONTINUE_PROMPT = `# Continue from last

Pick up the in-flight work in this workspace and continue it.

1. Reconstruct where things stand from the ground truth: \`git status --short\`, \`git log --oneline -10\`, uncommitted diffs, and any handoff, checkpoint, TODO, or plan files in the repo. Treat handoff notes as hypotheses and verify them against the actual code.
2. State in 2 or 3 lines what the in-flight work is and what remains, before touching anything.
3. Continue that work. Do not start something new, re-do finished parts, or "clean up" unrelated code along the way.
4. If the trail is ambiguous (multiple unfinished threads, contradictory state), list the threads and ask which one to continue instead of guessing.`;

export const HANDOFF_PROMPT = `# Hand off to another agent

Hand this work off to a different agent in this same task, using the termic CLI (\`$TERMIC_CLI\`; if unset, tell me it's disabled and stop).

1. Run \`"$TERMIC_CLI" agents --json\`, show me the usable ones, and ask which to use and what it should do.
2. Write \`handoff-$TERMIC_TASK_ID.md\` in the repo root: what I asked you to do, your plan, what you changed and why, and what the next agent should do. Point it at \`git diff\` / \`git log\` rather than pasting the diff.
3. \`"$TERMIC_CLI" tab "$TERMIC_TASK_ID" --agent <cli> -p "Read handoff-$TERMIC_TASK_ID.md, then <task>. When done, write your result to result-$TERMIC_TASK_ID.md and nowhere else."\`
4. Poll for \`result-$TERMIC_TASK_ID.md\`, then read it, that's the deliverable, not its last chat message.
5. Report what it says and the tab id. Don't close your own tab or exit.`;

export const SIMPLIFY_PROMPT = `# Simplify

Simplify the changes on this branch without changing behavior.

${SEE_CHANGES}

Look for:
- Dead code: unused exports, unreachable branches, leftover debug output, commented-out blocks.
- Premature abstraction: helpers, wrappers, or config used exactly once; three similar lines beat an early abstraction.
- Machinery where a primitive would do: a subsystem or per-frame solver where one property, flag, or existing utility gives the same observable result.
- Comments that narrate WHAT the code does or justify a workaround at length; keep only one-line WHY comments for genuine hidden constraints.

Rules: behavior stays identical, the diff stays small, and the test suite stays green (run it before and after). If something looks simplifiable but risky, list it instead of touching it.`;

/** The INSTRUCTION half of an issue-seeded task. The issue's own title,
 *  number, link and body are prepended at task-creation time
 *  (lib/issuePrompt.ts) - keeping them apart is what lets a user edit this
 *  text in the prompt library and have every future issue task pick it up.
 *  Deliberately tells the agent to fetch the comment thread itself: the
 *  discussion is usually where the real requirements are, and shipping the
 *  whole thread into the prompt would blow the context on issues that have
 *  been argued over for months. */
export const WORK_ISSUE_PROMPT = `Work on the issue above.

1. Read the full discussion before you write anything: run the fetch command listed above. The comments usually carry the real requirements, constraints the reporter added later, and decisions that contradict the original description. Where the body and a later comment disagree, the comment wins unless a maintainer says otherwise.
2. Reproduce the problem, or confirm the behavior the issue asks for is genuinely missing, before changing code. If you cannot reproduce it, say so and describe exactly what you tried instead of guessing at a fix.
3. Restate in 2 or 3 lines what you are going to change and why, then do it. Keep the change scoped to this issue: no drive-by refactors, renames, or unrelated fixes.
4. Match the project's existing conventions, and add or update the test that covers the behavior you changed, if the project has a test setup where that is natural.
5. Run the project's checks and show them passing.

Report at the end: what the issue actually asked for (including anything only the comments said), what you changed, and how to verify it.

Do not close the issue, comment on it, or open a pull request unless I ask. If the issue is unclear, already fixed, or you disagree that it should be done, say so plainly instead of implementing something adjacent.`;

export const FIX_MERGE_CONFLICT_PROMPT = `# Fix the merge conflicts

Resolve the merge conflicts in this repository, or bring the base branch in first if that is what is missing, so the merge or rebase can finish.

1. Get your bearings first: \`git status\` tells you whether a merge, rebase, cherry-pick, or revert is in flight, and \`git diff --name-only --diff-filter=U\` lists the conflicted files. Do not start editing before you know which operation you are in.
2. If nothing is in flight, check whether the base branch is even merged in yet: \`git fetch\`, then \`git merge-base --is-ancestor origin/main HEAD\` (use the repo's actual base branch if it is not main, for example master or develop). If it is not an ancestor, the branch is behind, so merge the base into the CURRENT branch first with \`git merge origin/main\` and resolve whatever conflicts that surfaces. Never merge the other direction, never switch branches, and never rebase instead unless I ask for it.
3. Understand BOTH sides before resolving. For each conflicted file, read the conflict hunks and use \`git log --oneline --merge -- <file>\` and \`git diff :2:<file> :3:<file>\` to see what each side was trying to do. "Ours" and "theirs" swap meaning during a rebase, so confirm which is which instead of assuming.
4. Resolve by intent, not by picking a side to make the markers go away. Keep both changes when both are still wanted, and merge them properly (both new imports, both new cases, both new tests). Take one side only when the other is genuinely superseded, and say why.
5. Never leave conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) behind. Grep for them across the tree when you think you are done.
6. Watch for semantic conflicts the tool cannot see: a rename on one side and a new caller on the other, a signature change plus a new call site, lockfiles and generated files (regenerate those from their source rather than hand-merging).
7. Stage each resolved file with \`git add\`, then finish the operation (\`git merge --continue\`, \`git rebase --continue\`, or the matching command for what is in flight). Do not commit while files are still unresolved.
8. Run the project's typecheck and test suite after resolving. A clean merge that does not compile is not resolved.

Never run \`git merge --abort\`, \`git rebase --abort\`, \`git reset --hard\`, or \`git checkout --ours/--theirs\` across the whole tree to escape a hard conflict. If a conflict needs a decision you cannot make, stop with the file, both sides, and the question.

Report: each conflicted file, how you resolved it, and the result of the checks.`;
