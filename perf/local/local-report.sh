#!/bin/bash
# Tier 3 of `make perf`: the measurements that CANNOT run in CI.
#
# Idle CPU, WindowServer cost and GPU utilisation need a real GPU, a real
# display and an undisturbed desktop. On a virtualised runner every one of the
# seven traps in perf/local/README.md produces a plausible wrong number instead of
# an error, which is worse than not measuring. So these live here, behind a
# human, and never in a workflow. See docs/perf-ci.md.
#
# Exits 0 even when it cannot measure. This is a reporting tool, not a gate,
# and `make perf` must still surface the CI-suite section that ran before it.

set -u
export LC_ALL=C
cd "$(dirname "$0")"

APP="${TERMIC_APP:-Termic Beta}"
DUR="${TERMIC_BENCH_SECONDS:-20}"

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Section 2 — LOCAL ONLY (idle CPU / GPU / compositor)"
echo "════════════════════════════════════════════════════════════════"
echo

if [ "$(uname)" != "Darwin" ]; then
  echo "  SKIPPED: macOS only (uses ioreg + WindowServer sampling)."
  exit 0
fi

if ! pgrep -f "$APP.app/Contents/MacOS/termic$" >/dev/null 2>&1; then
  cat <<EOF
  SKIPPED: "$APP" is not running.

  This section measures a LIVE app against the real compositor, so it
  cannot launch one for you and still be trustworthy (window size and
  focus both change the answer by more than the effect being measured).

  To include it:
    1. Install/launch the app     (make install, or open -a "$APP")
    2. Maximise its window        (canvas pixel count dominates, trap 3)
    3. Leave the machine alone    (ambient typing invalidates a run, trap 7)
    4. Re-run: make perf

  Override the app name with TERMIC_APP="Termic".
EOF
  exit 0
fi

echo "  App is running. Sampling for ${DUR}s per arm."
echo "  LEAVE THE MACHINE ALONE — typing anywhere invalidates the run."
echo

# One idle sample. Deliberately not the full three-renderer A/B (run-three.sh),
# which quits and relaunches the app repeatedly and takes many minutes; that
# stays an explicit opt-in for when someone is actually chasing a renderer
# question.
./measure.sh "idle" "$DUR"

echo
cat <<'EOF'
  Reading these numbers:
    front=ok        the sample is usable
    front=LOST[..]  DISCARD IT. The window lost focus or was occluded, which
                    collapses every metric at once and reads as "free".

  A focused terminal is never idle (cursor blink, trap 4), so this is
  "idle with a focused terminal", not "idle". Full renderer A/B:
    ./perf/local/run-three.sh 5 20
EOF
