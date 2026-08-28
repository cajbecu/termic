#!/bin/bash
# Fixture "agent CLI" for e2e runs (see .claude/skills/e2e + docs/e2e-tests.md).
# Registered in the scratch profile so tasks spawn / resume / queue against a
# real PTY with ZERO tokens.
#
# Built to behave like `claude` so termic's agent-state UI (working indicator,
# attention badge, notifications) is exercised realistically:
#   - long-lived interactive PTY: stays alive until signalled, like a TUI.
#   - drives the OSC terminal title with claude's status glyphs — `✳` when
#     idle (work done), a Braille spinner while working. termic classifies
#     these exactly as it classifies real claude (see BUILTIN_TITLE_SIGNALS
#     `claude` in src/lib/agents.ts). The `fakeagent` registry entry must carry
#     the same `capabilities.signals` for the classifier to fire (the e2e
#     profile seeds them — keep the two in lock-step).
#   - one busy -> idle cycle per submitted line, mirroring "type a prompt, it
#     works, it goes idle".
#   - echoes its argv so a test can assert resume flags (--session-id/--resume,
#     --name) reached the spawn.

set -u

# OSC 0 window/icon title, ST-terminated (ESC \). Deliberately NOT BEL-
# terminated: a stray BEL would trip termic's bell -> attention heuristic.
set_title() { printf '\033]0;%s\033\\' "$1"; }

# Braille spinner frames — the "leading glyph that isn't ✳" claude uses while
# working, which termic's busy signal `^\s*[^A-Za-z0-9\s✳]` matches.
SPINNER=("⣷" "⣯" "⣟" "⡿" "⢿" "⣻" "⣽" "⣾")

# claude shows the task in its title; pull it from --name if the spawn passed one.
name="fakeagent"
prev=""
for a in "$@"; do
  [ "$prev" = "--name" ] && name="$a"
  prev="$a"
done

# On exit, drop back to the idle glyph and say goodbye (like a clean quit).
trap 'set_title "✳ ${name}"; printf "\nFAKE-AGENT exiting\n"; exit 0' INT TERM

# Cold start: banner + idle title (awaiting input == work done).
echo "FAKE-AGENT ready (args: $*)"
echo "  claude-like fixture: ✳ = idle, spinner = working. Type a prompt."
set_title "✳ ${name}"

# Signal drills for the work-done specs. Real claude reaches states that a
# plain echo loop never does, so a line starting with `#` is a directive rather
# than a prompt:
#
#   #pending N  reproduce the backgrounded-subagent trap: print claude's
#               "Waiting for N background agents to finish" status line and go
#               to the IDLE glyph while the work is still outstanding. Every
#               byte-stream signal then says "finished" and only that line says
#               otherwise, which is the whole point.
#   #settle     clear the pending line (the work landed) and go idle for real.
#   #stage      a multi-stage turn whose FIRST stage looks finished: idle glyph,
#               quiet PTY, still screen, so termic calls the turn done. Then the
#               agent goes back to work long after that done and finishes for
#               real. Both halves have to survive: the spinner has to come back
#               (a done we got wrong must not outlive the evidence), and the
#               real completion still has to fire (the turn's done token was
#               spent on the wrong one). The sleep is long enough to clear
#               STICKY_DONE_MS counted from when the done actually fires, not
#               from when the stage ends.
#   #osc9 TEXT  emit an OSC 9 notification with a verbatim body, the way claude
#               asks for the user. BEL-terminated, as claude sends it.
#   #bel        emit a REAL bell, distinct from the BEL that terminates an OSC.
#   #iip        emit an inline PNG, then Pi's alternate-screen redraw.
osc9()   { printf '\033]9;%s\007' "$1"; }
spin()   { for f in 0 1 2; do set_title "${SPINNER[$f]} ${name}"; sleep 0.15; done; }

# One "prompt" per stdin line: go busy (spinner title + streamed output), then
# return to the idle glyph — the busy -> idle transition claude drives, which
# termic turns into working -> done.
while IFS= read -r line; do
  case "$line" in
    "#pending "*)
      spin
      # Order matters: the status line must be the LAST thing painted, so it
      # sits at the bottom of the screen where the pending check looks.
      echo "FAKE-AGENT backgrounded ${line#\#pending } agent(s)"
      echo "✻ Waiting for ${line#\#pending } background agents to finish"
      set_title "✳ ${name}"              # idle glyph WHILE work is outstanding
      continue ;;
    "#settle")
      # Enough lines to push the pending status line out of the bottom-of-screen
      # window the check looks at. That IS the real behaviour: claude's words
      # stay in the scrollback, they just stop being the live status.
      echo "FAKE-AGENT all background work landed"
      for i in 1 2 3 4 5 6 7 8 9 10; do echo "FAKE-AGENT result line ${i}"; done
      set_title "✳ ${name}"
      continue ;;
    "#stage")
      # ~1.5s of visible work before the misleading idle glyph — just enough for
      # termic to latch "working" (observed: ~0.7s from submit to badge).
      # This used to be ~6s: the done that follows only badges on a tab nobody
      # is watching, and the spec backgrounded the task by CREATING the second
      # one here (~1.5s), which raced the spinner. The spec now creates that
      # task up front and backgrounds with a store call, so the padding is gone.
      for i in $(seq 1 5); do set_title "${SPINNER[$((i % 8))]} ${name}"; sleep 0.3; done
      echo "FAKE-AGENT stage 1 landed"
      set_title "✳ ${name}"              # looks finished, isn't
      sleep 16
      spin                               # stage 2: back to work
      echo "FAKE-AGENT stage 2 landed"
      sleep 2
      set_title "✳ ${name}"              # finished for real this time
      continue ;;
    "#osc9 "*)
      osc9 "${line#\#osc9 }"
      continue ;;
    "#bel")
      printf '\007'
      continue ;;
    "#iip")
      # Match Pi's IIP redraw: clear the screen, reserve image rows, emit the
      # image from the last reserved row, then repeat after a layout shift.
      rows=$(stty size <&0 2>/dev/null | cut -d' ' -f1)
      rows=${rows:-24}
      printf '\033[?1049h'
      for top in 1 2; do
        printf '\033[?2026h\033[2J'
        image_row=$((top + 20))
        for ((row = 1; row <= rows; row++)); do
          printf '\033[%s;1H\033[2K' "$row"
          if ((row == image_row)); then
            printf '\033[20A'
            cat "$(dirname "$0")/../e2e/fixtures/iip/termic-icon.iip"
          elif ((row == image_row + 1)); then
            printf 'Pi redraw %s' "$top"
          fi
        done
        printf '\033[?2026l'
        sleep 0.1
      done
      set_title "✳ ${name} iip-after"
      continue ;;
  esac
  spin
  echo "FAKE-AGENT echo: ${line}"        # streamed "response"
  set_title "✳ ${name}"                  # done: idle glyph
done
