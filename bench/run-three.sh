#!/bin/bash
# GH #140 final: webgl vs canvas vs dom, idle terminal, maximized window.
#
# Design notes, all of them paid for by a discarded run:
#  - Maximized only. A 1500x1000 window on this DPR-1 panel is a ~0.8M pixel
#    canvas; the reporter's Retina MacBook is ~3.2M. Maximizing here lands at
#    ~3.4M, so this is the size that can speak to their numbers at all.
#  - Interleaved reps, median reported with min/max. WindowServer is shared
#    with every other window on screen, so a single sample is worthless; the
#    app's own processes are far tighter and carry the real signal.
#  - Every sample is bracketed by a frontmost check and retried once if the
#    foreground was lost, and the whole run aborts if the screen locks.
#  - peek records which renderer each arm ACTUALLY booted with, decoded from
#    the UTF-16LE blob, so a mislabelled arm cannot hide in the averages.
#
# THE MACHINE MUST BE LEFT ALONE. Typing anywhere pulls focus off Termic,
# which both deprioritizes the webview and stops xterm's cursor blink (worth
# ~4pp on the DOM arm by itself).
#
# usage: run-three.sh [reps] [measure-seconds]

set -u
export LC_ALL=C
cd "$(dirname "$0")"

# Overridable so the harness is not welded to one machine. The window size is
# the maintainer's panel; the point is a canvas large enough to compare with a
# Retina laptop (~3.2M pixels), so match pixel COUNT, not these numbers.
APP="${TERMIC_APP:-Termic Beta}"
WIN_W="${TERMIC_BENCH_W:-3840}"
WIN_H="${TERMIC_BENCH_H:-1600}"

caffeinate -dimsu -w $$ &
trap 'kill %1 2>/dev/null' EXIT

REPS="${1:-5}"
DUR="${2:-25}"
TASK="main"
LOG="three-$(date +%H%M%S).log"
CSV="three-$(date +%H%M%S).csv"

frontmost() {
  lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null \
    | sed -n 's/.*"LSDisplayName"="\([^"]*\)".*/\1/p'
}

raise_and_verify() {
  local t=0
  open -a "$APP"
  while [ $t -lt 10 ]; do
    [ "$(frontmost)" = "$APP" ] && return 0
    sleep 1; t=$((t + 1))
  done
}

maximize() {
  osascript -e 'tell application "System Events" to tell process "'"$APP"'"
      set position of window 1 to {0, 0}
      set size of window 1 to {'"$WIN_W"', '"$WIN_H"'}
    end tell' >/dev/null 2>&1
  sleep 3
  osascript -e 'tell application "System Events" to tell process "'"$APP"'" to get size of window 1' 2>/dev/null | tr -d ' '
}

wait_quiet() {
  local q=0 t=0 wc
  while [ $t -lt 18 ]; do
    wc=$(./measure.sh probe 4 | sed -n 's/.*webcontent=\([0-9.]*\).*/\1/p')
    [ -z "$wc" ] && wc=99
    if awk -v v="$wc" 'BEGIN{exit !(v < 3.0)}'; then
      q=$((q+1)); [ $q -ge 2 ] && return 0
    else q=0; fi
    t=$((t+1))
  done
}

[ "$(frontmost)" = "loginwindow" ] && { echo "ABORT: screen locked."; exit 1; }

echo "=== GH #140 THREE RENDERERS  reps=$REPS dur=${DUR}s  macOS $(sw_vers -productVersion) $(sysctl -n hw.model) 3840x1600 DPR1 ===" | tee -a "$LOG"
echo "kind,rep,ws,webcontent,webkitgpu,termic,gpu" > "$CSV"

termic-beta quit --yes >/dev/null 2>&1; sleep 6
./measure.sh "baseline-no-termic" "$DUR" | tee -a "$LOG"

for rep in $(seq 1 "$REPS"); do
  for kind in dom canvas webgl; do
    termic-beta quit --yes >/dev/null 2>&1; sleep 6
    ./setrenderer.sh "$kind" >/dev/null || { echo "setrenderer failed"; exit 1; }
    raise_and_verify; sleep 9
    termic-beta open "$TASK" >/dev/null 2>&1; sleep 4
    raise_and_verify
    win=$(maximize)
    wait_quiet
    got=$(./setrenderer.sh peek)

    out=$(./measure.sh "${kind}-r${rep}" "$DUR")
    if [[ "$out" == *"front=LOST"* ]]; then
      [ "$(frontmost)" = "loginwindow" ] && { echo "ABORT: screen locked mid-run." | tee -a "$LOG"; exit 1; }
      raise_and_verify
      out=$(./measure.sh "${kind}-r${rep}retry" "$DUR")
    fi
    echo "$out" | sed "s/\$/ win=${win:-?} booted=${got}/" | tee -a "$LOG"

    # Only bank samples that kept the foreground; a throttled webview would
    # drag the median toward "every renderer is free".
    if [[ "$out" != *"front=LOST"* ]]; then
      echo "$out" | awk -v k="$kind" -v r="$rep" '{
        for (i=1;i<=NF;i++) {
          split($i,a,"="); v[a[1]]=a[2]
        }
        print k","r","v["ws"]","v["webcontent"]","v["webkitgpu"]","v["termic"]","v["gpu_avg"]
      }' >> "$CSV"
    fi
  done
done

termic-beta quit --yes >/dev/null 2>&1; sleep 6
./measure.sh "baseline-no-termic-post" "$DUR" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "=== MEDIAN (min-max) over kept samples ===" | tee -a "$LOG"
for kind in dom canvas webgl; do
  awk -F, -v k="$kind" '
    $1==k { for (c=3;c<=7;c++) v[c][++n[c]]=$c }
    END {
      if (!n[3]) { printf "%-7s no valid samples\n", k; exit }
      printf "%-7s n=%d  ", k, n[3]
      split("ws webcontent webkitgpu termic gpu", nm, " ")
      for (c=3;c<=7;c++) {
        m=n[c]; for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(v[c][i]>v[c][j]){t=v[c][i];v[c][i]=v[c][j];v[c][j]=t}
        med=(m%2)?v[c][(m+1)/2]:(v[c][m/2]+v[c][m/2+1])/2
        printf "%s=%.1f(%.1f-%.1f) ", nm[c-2], med, v[c][1], v[c][m]
      }
      printf "\n"
    }' "$CSV" | tee -a "$LOG"
done
echo "=== done -> $LOG / $CSV ===" | tee -a "$LOG"
