#!/bin/bash
# Measure standing compositor cost for GH #140.
#
# WindowServer CPU is a *cputime delta* over the window (ps %CPU is a
# lifetime average and useless here). GPU is "Device Utilization %" from
# ioreg, sampled repeatedly and averaged. WebKit's WebContent/GPU helper
# processes are sampled the same way so we can see whether the cost lands
# in the compositor or in the app.
#
# macOS ships bash 3.2: no associative arrays, no `declare -A`.
#
# usage: measure.sh <label> <seconds>

set -u
# The maintainer's locale formats decimals with a comma, so awk printed
# "159639,08" and the next awk parsed it back as 159639 -- every sub-second
# delta silently rounded to 0. Pin C for the whole script.
export LC_ALL=C
APP="${TERMIC_APP:-Termic Beta}"
LABEL="${1:-unlabeled}"
DUR="${2:-20}"

# cputime "1-02:03:04" | "2660:39.08" | "39.08" -> seconds
cpu_secs() {
  [ -z "${1:-}" ] && { echo ""; return; }
  awk -F'[-:]' '{
    s=0; mult=1
    for (i=NF; i>=1; i--) { s += $i * mult; mult *= (i==2 && NF>=4) ? 24 : 60 }
    printf "%.2f", s
  }' <<<"$1"
}

pid_time() { [ -n "${1:-}" ] && ps -o time= -p "$1" 2>/dev/null | tr -d ' '; }

WS=$(pgrep -x WindowServer | head -1)
TM=$(pgrep -f "$APP.app/Contents/MacOS/termic$" | head -1)

# WebKit XPC services are all parented to launchd (ppid 1), and several apps
# on this box have their own set, so ppid can't attribute them. They are
# spawned moments after their host, so the app's helper is the lowest pid
# above the app's. Re-resolved every run because a relaunch renumbers them.
helper_for() { # $1 = pgrep pattern
  [ -z "${TM:-}" ] && return
  pgrep -f "$1" 2>/dev/null | sort -n | awk -v t="$TM" '$1 > t { print; exit }'
}
WC=$(helper_for "WebKit.WebContent")
WG=$(helper_for "WebKit.GPU")

WS0=$(cpu_secs "$(pid_time "$WS")")
WC0=$(cpu_secs "$(pid_time "$WC")")
WG0=$(cpu_secs "$(pid_time "$WG")")
TM0=$(cpu_secs "$(pid_time "$TM")")

# WKWebView throttles rendering when its window is occluded, and an occluded
# window is also cheap to composite -- so an unnoticed occlusion silently
# collapses every metric at once and reads as "the GL surface costs nothing".
# Frontmost is a conservative proxy for visible: bracket the window and let
# the caller discard any sample that didn't stay on Termic throughout.
frontmost() {
  lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null \
    | sed -n 's/.*"LSDisplayName"="\([^"]*\)".*/\1/p'
}
FRONT0=$(frontmost)

gpu_sum=0; gpu_n=0; gpu_max=0
end=$((SECONDS + DUR))
while [ $SECONDS -lt $end ]; do
  g=$(ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "${g:-}" ]; then
    gpu_sum=$((gpu_sum + g)); gpu_n=$((gpu_n + 1))
    [ "$g" -gt "$gpu_max" ] && gpu_max=$g
  fi
  sleep 0.5
done

WS1=$(cpu_secs "$(pid_time "$WS")")
WC1=$(cpu_secs "$(pid_time "$WC")")
WG1=$(cpu_secs "$(pid_time "$WG")")
TM1=$(cpu_secs "$(pid_time "$TM")")

pct() { # $1=before $2=after -> %CPU over the window
  if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then echo "n/a"; return; fi
  awk -v a="$1" -v b="$2" -v d="$DUR" 'BEGIN{printf "%.1f", (b-a)/d*100}'
}

gpu_avg=$(awk -v s=$gpu_sum -v n=$gpu_n 'BEGIN{printf "%.1f", n?s/n:0}')

FRONT1=$(frontmost)
case "$FRONT0|$FRONT1" in
  "$APP|$APP") FRONT="ok" ;;
  *) FRONT="LOST[$FRONT0->$FRONT1]" ;;
esac

printf '%-26s ws=%-6s webcontent=%-6s webkitgpu=%-6s termic=%-6s gpu_avg=%-5s gpu_max=%-4s front=%-8s (%ss, %d samples)\n' \
  "$LABEL" "$(pct "$WS0" "$WS1")" "$(pct "$WC0" "$WC1")" "$(pct "$WG0" "$WG1")" \
  "$(pct "$TM0" "$TM1")" "$gpu_avg" "$gpu_max" "$FRONT" "$DUR" "$gpu_n"
