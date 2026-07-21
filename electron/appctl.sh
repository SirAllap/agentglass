#!/usr/bin/env bash
# Finding and stopping an installed agentglass desktop instance.
#
# Sourced by install-local.sh (and exercised by server/test/install-stop.test.ts),
# which is why it is a library rather than inline: the interesting part is not
# the install, it is knowing which processes belong to this install and waiting
# for them to actually be gone.
#
# Expects APP to be set to the install directory (…/agentglass-desktop).

# The resolved binary behind a pid, or nothing.
#
# /proc/<pid>/exe rather than the command line, for three reasons this script has
# been bitten by: an instance launched through the ~/.local/bin symlink has a
# different argv[0]; every Electron helper repeats the same path in its own argv,
# so a cmdline match cannot tell main from renderer; and an instance whose files
# were already replaced still answers here, with a "(deleted)" suffix, which is
# precisely the state we are trying to avoid creating.
_exe_of() {
  local link
  link=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  printf '%s\n' "${link% (deleted)}"
}

# Anything whose command line mentions us at all — the cheap first pass.
#
# One grep over /proc beats a readlink per pid by a wide margin, and it matters:
# app_pids is called in a polling loop, and walking every process on a busy
# machine took the best part of a second per call, which turned a bounded wait
# into a visible stall. This over-matches on purpose (a shell sitting in a
# directory named agentglass lands here too); app_pids does the precise part.
_candidate_pids() {
  local f
  for f in $(grep -la -e agentglass /proc/[0-9]*/cmdline 2>/dev/null); do
    f=${f#/proc/}
    printf '%s\n' "${f%/cmdline}"
  done
}

# Every pid belonging to this install: the app and its sidecar, helpers included.
app_pids() {
  local pid exe
  for pid in $(_candidate_pids); do
    exe=$(_exe_of "$pid") || continue
    case "$exe" in
      "$APP/agentglass"|"$APP/resources/agentglass-server") printf '%s\n' "$pid" ;;
    esac
  done
}

# The Electron main process alone.
#
# This is the one that must receive the SIGTERM. Signalling the whole tree at
# once — which is what `pkill -f "$APP/agentglass"` did — tears the children out
# from under the main process while it is running its own quit path
# (stopSidecar() then app.quit()), and the result is a frozen window that can
# outlive the rebuild by half an hour. Every helper carries --type=; main does
# not.
main_pids() {
  local pid exe args
  for pid in $(app_pids); do
    exe=$(_exe_of "$pid") || continue
    [ "$exe" = "$APP/agentglass" ] || continue
    args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
    case " $args " in
      *" --type="*) ;;
      *) printf '%s\n' "$pid" ;;
    esac
  done
}

# Wait until nothing from this install is left, up to `$1` tenths of a second.
# Returns 0 when the install is clear, 1 if the deadline passed with survivors.
_wait_gone() {
  local tries=$1
  while [ "$tries" -gt 0 ]; do
    if [ -z "$(app_pids)" ]; then return 0; fi
    sleep 0.1
    tries=$((tries - 1))
  done
  [ -z "$(app_pids)" ]
}

# Stop the running instance, politely first. Returns 1 if anything survives,
# because the caller's next move is rm -rf over these very files.
stop_app() {
  local mains leftovers grace
  grace=${APPCTL_GRACE_TENTHS:-100}
  [ -n "$(app_pids)" ] || return 0

  mains=$(main_pids)
  if [ -n "$mains" ]; then
    echo "==> stopping the running instance (main: $(echo "$mains" | tr '\n' ' '))"
    kill $mains 2>/dev/null || true
  else
    # No main process: helpers that outlived their parent, or a sidecar left
    # behind by a previous wedge. Nothing to ask politely, so skip to the end.
    echo "==> clearing leftovers from a previous instance"
  fi

  # Poll rather than sleep a fixed guess. Measured against the main process
  # alone, a healthy instance is gone in about two seconds; the window here is
  # generous so that a slow quit gets waited out instead of raced by the copy.
  # (The knob exists so the tests can reach the escalation path in under a
  # second. Nothing outside them should set it.)
  if [ -n "$mains" ] && _wait_gone "$grace"; then return 0; fi

  leftovers=$(app_pids)
  if [ -n "$leftovers" ]; then
    echo "   still up after $((grace / 10))s — killing $(echo "$leftovers" | wc -l) process(es)"
    kill -9 $leftovers 2>/dev/null || true
    _wait_gone 30 || true
  fi

  [ -z "$(app_pids)" ]
}
