#!/bin/bash
# Point Termic Beta at one of the three xterm renderers, with the app quit.
#
# Writes BOTH keys, mirroring setTerminalRenderer in prefs.ts. Writing only
# terminalRenderer would still boot correctly (it wins over the boolean), but
# leaving a contradictory terminalGpuEnabled behind would make `peek` output
# ambiguous, and peek is the only ground truth this harness has for which
# renderer an arm actually ran.
#
# WKWebView persists localStorage strings as UTF-16LE blobs, hence the hex.
#
# usage: setrenderer.sh webgl|canvas|dom|peek

set -eu
export LC_ALL=C
APP="${TERMIC_APP:-Termic Beta}"
DB=$(ls ~/Library/WebKit/com.simion.termic.beta/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3 2>/dev/null | head -1)
[ -n "$DB" ] || { echo "no localstorage.sqlite3 for com.simion.termic.beta"; exit 1; }

# CAST(value AS TEXT) stops at the first NUL, so a UTF-16LE "canvas" reads back
# as "c". Pull the raw hex and decode it instead, or peek silently agrees with
# every arm label.
decode() {
  local h
  h=$(sqlite3 "$DB" "SELECT hex(value) FROM ItemTable WHERE key='$1';" 2>/dev/null)
  [ -z "$h" ] && { echo "unset"; return; }
  python3 -c "import sys;print(bytes.fromhex(sys.argv[1]).decode('utf-16-le'))" "$h"
}

if [ "${1:-peek}" = "peek" ]; then
  echo "$(decode terminalRenderer)/gpu=$(decode terminalGpuEnabled)"
  exit 0
fi

case "${1}" in webgl|canvas|dom) KIND="$1" ;; *) echo "usage: setrenderer.sh webgl|canvas|dom|peek"; exit 2 ;; esac

if pgrep -f "$APP.app/Contents/MacOS/termic$" >/dev/null; then
  echo "REFUSING: $APP is running; quit it first"
  exit 1
fi

hex=$(python3 -c "import sys;print(sys.argv[1].encode('utf-16-le').hex())" "$KIND")
gpu=$([ "$KIND" = "webgl" ] && echo "3100" || echo "3000")

sqlite3 "$DB" "
  INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('terminalRenderer',   X'$hex');
  INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('terminalGpuEnabled', X'$gpu');"

echo "renderer = $(sqlite3 "$DB" "SELECT CAST(value AS TEXT) FROM ItemTable WHERE key='terminalRenderer';")"
