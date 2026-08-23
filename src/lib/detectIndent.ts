// What this file is indented with, read from the file itself.
//
// The editor used to hard-code two spaces for everything, which is wrong the
// moment you open Python (4), a Makefile (tabs, and they are load-bearing), or
// a Go file. Guessing from the content is what VS Code does by default
// (`editor.detectIndentation`), and it needs no configuration to be right,
// which matters here: the files an agent just wrote are the ones being read.
//
// Deliberately NOT a parser. The signal is the DIFFERENCE between the
// indentation of consecutive indented lines, which is robust against
// continuation lines, wrapped arguments and block comments in a way that
// "smallest indentation seen" is not: a file full of 8-space continuations
// still steps by 4.

export interface IndentStyle {
  /** True when the file leads with tabs. */
  useTabs: boolean;
  /** Columns per level. Also the width a tab renders as. */
  size: number;
  /** What one level actually is, for CodeMirror's `indentUnit`. */
  unit: string;
}

/** Sizes worth counting. 3 and 5 exist in the wild but guessing them from a
 *  handful of lines does more harm than falling back. */
const CANDIDATES = [2, 4, 8] as const;

/** How many lines to look at. A few hundred settles the question, and this
 *  runs on the critical path of opening a file. */
const MAX_LINES = 500;
/** Slice the text before splitting it: `split("\n", limit)` still walks the
 *  whole string first, which on a multi-megabyte file is the cost this cap
 *  exists to avoid. 64 KB comfortably holds 500 lines of anything. */
const MAX_BYTES = 64 * 1024;

export function detectIndent(text: string, fallback: IndentStyle = { useTabs: false, size: 2, unit: "  " }): IndentStyle {
  const lines = text.slice(0, MAX_BYTES).split("\n", MAX_LINES);
  let tabLines = 0;
  let spaceLines = 0;
  // How many times each step size was seen between one indented line and the
  // next. Keyed by size.
  const votes = new Map<number, number>();
  let prevIndent = 0;

  for (const line of lines) {
    if (!line.trim()) continue;                 // blank lines say nothing
    const match = /^[\t ]+/.exec(line);
    const lead = match ? match[0] : "";
    if (lead.includes("\t")) {
      // A tab anywhere in the leading whitespace means tabs: mixed leads are
      // usually tab-indented files with alignment spaces after the tabs.
      tabLines++;
      prevIndent = 0;
      continue;
    }
    if (!lead) { prevIndent = 0; continue; }
    spaceLines++;
    const indent = lead.length;
    const step = Math.abs(indent - prevIndent);
    if (step > 0 && CANDIDATES.includes(step as 2 | 4 | 8)) {
      votes.set(step, (votes.get(step) ?? 0) + 1);
    }
    prevIndent = indent;
  }

  // Tabs win on a plurality, not a majority: a tab-indented file still has
  // space-aligned continuation lines, and one tab line is unambiguous where
  // one space line is not.
  if (tabLines > 0 && tabLines >= spaceLines / 4) {
    return { useTabs: true, size: fallback.size === 2 ? 4 : fallback.size, unit: "\t" };
  }

  let best = 0;
  let bestVotes = 0;
  for (const [size, count] of votes) {
    // Ties go to the SMALLER size: a file that steps by 4 also steps by 8 at
    // two levels of nesting, so 8 wins ties it has not earned.
    if (count > bestVotes || (count === bestVotes && size < best)) {
      best = size;
      bestVotes = count;
    }
  }
  // One or two observations is not evidence. Fall back rather than commit to a
  // width the rest of the file will fight.
  if (best === 0 || bestVotes < 2) return fallback;
  return { useTabs: false, size: best, unit: " ".repeat(best) };
}
