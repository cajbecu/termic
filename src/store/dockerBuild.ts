// The pre-launch Docker image rebuild, as something you can WATCH.
//
// The rebuild is awaited before an agent spawns and can take minutes (it is a
// --no-cache build of a multi-GB image). All it used to show was a toast, so
// the pane sat empty with no way to tell a slow build from a wedged one - and
// when it genuinely did wedge, nothing on screen said so.
//
// Its own store rather than a field on useApp: log lines arrive several times
// a second, and writing those through the app store would re-run every
// mounted task's selectors for output only one pane is showing (see
// docs/performance.md bear trap 8). Only the overlay subscribes here.
import { create } from "zustand";

/** Keep the tail, not the whole build. A no-cache build emits thousands of
 *  lines; the last screenful is what tells you it is alive, and an unbounded
 *  array is a memory leak on a long build. */
const MAX_LINES = 400;

export interface DockerBuildState {
  /** Task whose launch is waiting on this build. Null = nothing building. */
  taskId: string | null;
  lines: string[];
  status: "building" | "done" | "failed";
  start: (taskId: string) => void;
  append: (line: string) => void;
  finish: (ok: boolean) => void;
  clear: () => void;
}

export const useDockerBuild = create<DockerBuildState>((set) => ({
  taskId: null,
  lines: [],
  status: "building",
  start: (taskId) => set({ taskId, lines: [], status: "building" }),
  append: (line) => set(s => {
    if (!s.taskId) return s;   // nothing is building; ignore a stray event
    const next = s.lines.length >= MAX_LINES
      ? [...s.lines.slice(s.lines.length - MAX_LINES + 1), line]
      : [...s.lines, line];
    return { lines: next };
  }),
  finish: (ok) => set(s => (s.taskId ? { status: ok ? "done" : "failed" } : s)),
  clear: () => set({ taskId: null, lines: [], status: "building" }),
}));
