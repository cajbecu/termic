// Shared collector for the nightly perf run. Specs push rows; the launcher
// assembles one JSON file that GitHub renders as a step summary.
//
// CROSS-PROCESS BY NECESSITY. WebdriverIO runs each spec in a forked worker,
// so an in-memory array populated by specs is invisible to `onComplete` in the
// launcher. Rows are therefore appended as NDJSON to a file both sides agree
// on via TERMIC_PERF_NDJSON (workers inherit the launcher's env), and the
// launcher folds that into the final report.
//
// UNGATED ON PURPOSE. Nothing here throws on a slow number, and that is a
// decision, not an omission. This runs on macos-14, a 3-core virtualised
// runner with no Metal Performance Shaders exposed to the guest. Orca can gate
// its nightly latency budgets because it runs on Linux under xvfb where there
// is no GPU variance; we cannot copy that part. So: collect a timestamped
// series, learn the spread, and only then decide which metrics have earned a
// threshold. Reasoning in docs/research/perf-ci.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PerfRow {
  /** Stable key, e.g. "startup.bootToFirstPaintMs". Used to line up series. */
  metric: string;
  value: number | null;
  unit: "ms" | "MiB" | "count" | "text";
  /** Free text shown next to the number: what it is, or why it is null. */
  note?: string;
  /** Individual samples, when the value is a median. Kept so a weird median
   *  can be diagnosed later without re-running. */
  samples?: number[];
}

type Entry =
  | { kind: "row"; row: PerfRow }
  | { kind: "fact"; key: string; value: string };

function ndjsonPath(): string {
  return process.env.TERMIC_PERF_NDJSON ?? path.join(process.cwd(), ".perf", "rows.ndjson");
}

function append(entry: Entry): void {
  const p = ndjsonPath();
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

export function record(row: PerfRow): void {
  append({ kind: "row", row });
  const shown = row.value === null ? "null" : row.value;
  console.log(`  [perf] ${row.metric} = ${shown} ${row.unit}${row.note ? `  (${row.note})` : ""}`);
}

/** Environment facts that make a number interpretable later: the WebGL
 *  renderer, the runner, the commit. A series without these is uncomparable
 *  across machines. */
export function fact(key: string, value: string): void {
  append({ kind: "fact", key, value });
  console.log(`  [perf] ${key}: ${value}`);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Launcher-side: drop any NDJSON left by a previous run. */
export function resetCollector(): void {
  const p = ndjsonPath();
  mkdirSync(path.dirname(p), { recursive: true });
  rmSync(p, { force: true });
}

/** Launcher-side: fold the workers' NDJSON into the report + step summary. */
export function flush(outPath: string): void {
  const p = ndjsonPath();
  const rows: PerfRow[] = [];
  const facts: Record<string, string> = {};

  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Entry;
        if (e.kind === "row") rows.push(e.row);
        else facts[e.key] = e.value;
      } catch {
        // A truncated final line means a worker died mid-write. Keep the rows
        // we do have rather than losing the whole run to one bad line.
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? "local",
    runner: process.env.RUNNER_NAME ?? process.env.GITHUB_JOB ?? "local",
    runId: process.env.GITHUB_RUN_ID ?? null,
    facts,
    rows,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n[perf] wrote ${rows.length} rows to ${outPath}`);

  // GitHub renders this in the run UI. Without it the numbers live only inside
  // a downloadable artifact, and a nightly nobody reads is dead weight.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, renderMarkdown(report));
  else console.log("\n" + renderMarkdown(report));
}

function renderMarkdown(r: {
  facts: Record<string, string>;
  rows: PerfRow[];
}): string {
  const lines: string[] = [
    "## Nightly performance report",
    "",
    "Ungated: a trend line, not a pass/fail. See `docs/research/perf-ci.md`.",
    "",
    "| Metric | Value | Unit | Note |",
    "| --- | ---: | --- | --- |",
  ];
  if (!r.rows.length) {
    lines.push("| _no rows collected_ | | | the run produced nothing |");
  }
  for (const row of r.rows) {
    const v = row.value === null ? "_n/a_" : String(row.value);
    lines.push(`| \`${row.metric}\` | ${v} | ${row.unit} | ${row.note ?? ""} |`);
  }
  if (Object.keys(r.facts).length) {
    lines.push("", "<details><summary>Environment</summary>", "");
    for (const [k, v] of Object.entries(r.facts)) lines.push(`- **${k}**: ${v}`);
    lines.push("", "</details>");
  }
  return lines.join("\n") + "\n";
}
