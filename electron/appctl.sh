#!/usr/bin/env bash
# Finding and stopping an installed agentglass desktop instance.
#
# Sourced by install-local.sh (and exercised by server/test/install-stop.test.ts),
# which is why it is a library rather than inline: the interesting part is not
# the install, it is knowing which processes belong to this install and waiting
# for them to actually be gone.
#
# Expects APP to be set to the install directory (…/agentglass-desktop).

# The variables the running server DERIVES for itself, which must never reach an
# app this script launches.
#
# AGENTGLASS_TOKEN is the one that bites. `rotateToken` refuses when it is set —
# correctly: rotating a file the server does not read would report a revoke that
# did not happen — so "Revoke this link" answers with a note about an environment
# variable the user never set and cannot find. That cost an Electron inspector
# session to establish, because /proc/<pid>/environ shows the exec-time snapshot
# and told us it was not there.
#
# One list, used twice, because the two uses are not the same thing and only
# doing both is enough: it is filtered OUT of what gets replayed, and it is
# `env -u`'d out of the launch. Not replaying it was the whole of the previous
# fix, and it protected nothing — the installer inherits these from the shell
# that started it (server/src/selfupdate.ts spawns the update script with the
# sidecar's environment), and `env FOO=bar cmd` ADDS to that environment, it
# does not replace it. Measured: with the seven exported around it, a reopened
# instance had all seven, replay list or no replay list.
#
# server/src/selfupdate.ts holds the same list for the same reason and
# server/test/install-stop.test.ts fails if the two ever drift.
APPCTL_DERIVED=(
  AGENTGLASS_TOKEN AGENTGLASS_PORT AGENTGLASS_BIND AGENTGLASS_TRUST_LAN
  AGENTGLASS_WEB_DIR AGENTGLASS_DIE_WITH_PARENT AGENTGLASS_PTY_SIZE_FILE
)
APPCTL_UNSET=()
for _n in "${APPCTL_DERIVED[@]}"; do APPCTL_UNSET+=(-u "$_n"); done
unset _n
# `^AGENTGLASS_(TOKEN|PORT|…)=`, built from the list above so there is nowhere
# for a seventh variable to be added to one of them and not the other.
APPCTL_DERIVED_RE="^($(IFS='|'; printf '%s' "${APPCTL_DERIVED[*]}"))="

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
# outlive the rebuild by half an hour.
#
# The test is --type=, which every helper carries and main never does. Not the
# shape of the whole command line: `^$APP/agentglass$` excludes the helpers
# correctly and also excludes `agentglass --ozone-platform=wayland`, which is an
# ordinary way to launch this app. Missing the main process there is worse than
# the bug being fixed, because the caller reads "nothing running" and installs
# over it.
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

# The sidecar of the instance whose pid is `$1`, or of this install at large.
#
# Its environment is the only place the app's own AGENTGLASS_* can still be
# read: the Electron main process has none to read (see _capture_restart), and
# main.js spawns the sidecar with `{ ...process.env, … }`, so whatever scoped
# the window is in there. A Bun binary does not rewrite its own environ block —
# measured against the live app, the main process showed 0 variables and its
# sidecar 78.
#
# Its CHILDREN first, not a walk of /proc. main.js spawns the sidecar, so it is
# a direct child, and reading one file beats grepping 829 cmdlines — measured on
# this machine at 415-453 ms per walk, which is the same cost _candidate_pids
# exists to warn about, added to a stop_app that already pays it twice. The walk
# is still the fallback, because an ADOPTED sidecar (main.js reuses one that is
# already listening) is nobody's child.
_sides_among() {
  local pid exe
  for pid in "$@"; do
    exe=$(_exe_of "$pid") || continue
    [ "$exe" = "$APP/resources/agentglass-server" ] && printf '%s\n' "$pid"
  done
}
sidecar_pids() {
  local main=${1:-} out=""
  # An Electron main always has children — the helpers — so "it had children"
  # is not the test. Finding a SIDECAR among them is; anything else falls
  # through to the walk rather than quietly reporting none.
  if [ -n "$main" ]; then
    out=$(_sides_among $(cat "/proc/$main/task/$main/children" 2>/dev/null))
    [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
  fi
  _sides_among $(_candidate_pids)
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

# How the instance we are about to stop was started, so it can be put back the
# same way. Empty means nothing was running, which is the difference between
# "reopen it" and "open something the user had deliberately closed".
#
# One argument per line rather than the NUL-separated bytes /proc hands over,
# because a shell variable cannot hold a NUL. The assumption that costs is an
# argument containing a newline, which no way of launching this app produces.
APPCTL_RESTART_ARGV=""
APPCTL_RESTART_ENV=""

# One argument per line, out of a /proc cmdline blob on stdin.
#
# `tr` alone was not enough, and the way it failed was silent. Chromium rewrites
# its argv block in place to set the process title, and the Electron main
# process is left with ONE space-joined string and a single trailing NUL:
# measured, /proc/<main>/cmdline has zero NUL separators where a /bin/sh started
# with the same arguments has four. So the whole command line arrived as a
# single line, `${args[@]:1}` dropped it, and an instance started the ordinary
# way — `agentglass --ozone-platform=wayland`, `--no-sandbox` — was reopened
# bare. The tests never saw it because their fake install is /bin/sh, which
# leaves its cmdline alone.
#
# Splitting the rewritten form on spaces assumes no argument contains one. That
# holds here: everything this app is launched with is a switch, and the one
# thing that could carry a path — which project the window is scoped to — goes
# through the environment, not argv.
_split_cmdline() {
  local out
  out=$(tr '\0' '\n')
  if [ "$(printf '%s\n' "$out" | wc -l)" -gt 1 ]; then
    printf '%s\n' "$out"
  else
    printf '%s\n' "$out" | tr ' ' '\n'
  fi
}

# Read a stopped instance's command line and the environment that scoped it.
#
# Only AGENTGLASS_* is carried over. Restoring the whole environment would put
# back whatever session the app happened to be launched from — stale sockets,
# a dead SSH agent, a display that has since gone away — while the variables
# that actually change what the app *is* are ours: `make desktop-open` scopes a
# window to one repo with AGENTGLASS_PROJECT, and reopening it unscoped would
# silently be a different app than the one that was closed.
_capture_restart() {
  local pid=$1 spid
  APPCTL_RESTART_ARGV=$(_split_cmdline < "/proc/$pid/cmdline" 2>/dev/null) || APPCTL_RESTART_ARGV=""
  # Only the variables that are the INSTANCE's, never the ones it derives.
  #
  # Read off the SIDECAR, because the Electron main process has no environment
  # left to read. Chromium rewrites the argv+environ block in place to set its
  # process title, and what it leaves behind is nothing: measured on the running
  # desktop app, the main process's environ was 2749 bytes without one non-NUL
  # byte in it, against 78 variables in its sidecar. So this read the main
  # process and always got an
  # empty string — the scoping replay that is the entire reason the capture
  # exists (AGENTGLASS_ROOT is why a reopened window comes back on the same
  # project) has never once happened on a real install, and the filter below
  # was filtering nothing.
  #
  # The filter still matters, and now for a real reason: the sidecar's set is
  # exactly the polluted one, since main.js spawns it with `{ ...process.env,
  # AGENTGLASS_TOKEN: …, AGENTGLASS_PORT: … }`. What survives here is what the
  # app was scoped WITH and not what it worked out for itself.
  spid=$(sidecar_pids "$pid" | head -n 1)
  APPCTL_RESTART_ENV=""
  [ -n "$spid" ] && APPCTL_RESTART_ENV=$(tr '\0' '\n' < "/proc/$spid/environ" 2>/dev/null \
    | grep '^AGENTGLASS_[A-Za-z0-9_]*=' \
    | grep -vE "$APPCTL_DERIVED_RE" || true)
  # An instance we could not read is one we must not claim to be able to
  # restore: reopening with the wrong arguments is worse than not reopening.
  [ -n "$APPCTL_RESTART_ARGV" ] || return 0
}

# Reopen what stop_app took down, if it took anything down.
#
# Deliberately not "launch the app": an install run while nothing was open
# leaves nothing open, because the person who closed it meant to. This only
# puts back the instance that was there a moment ago, with the arguments and the
# scoping it had.
start_app() {
  [ -n "$APPCTL_RESTART_ARGV" ] || return 0
  [ -x "$APP/agentglass" ] || return 1

  local args=() env=() line
  # argv[0] is dropped: it may be the ~/.local/bin symlink, or a path into an
  # install directory that has just been replaced. The binary to run is the one
  # we installed, by definition.
  while IFS= read -r line; do
    [ -n "$line" ] && args+=("$line")
  done <<< "$APPCTL_RESTART_ARGV"
  args=("${args[@]:1}")
  while IFS= read -r line; do
    [ -n "$line" ] && env+=("$line")
  done <<< "$APPCTL_RESTART_ENV"

  echo "==> reopening (${#args[@]} arg(s)${env:+, scoped})"
  # Detached from this shell in its own session, so the app outlives the install
  # script rather than dying with the terminal it was rebuilt from. `setsid`
  # where there is one; a plain background job is the fallback, and the `disown`
  # keeps a hangup from reaching it.
  #
  # `env -u` before the assignments, because leaving a variable out of the
  # replay list does not remove it from the environment this script is running
  # in. From `make desktop-update` in a plain terminal there is nothing to
  # remove; from the update button there is everything — the update script is
  # spawned with the sidecar's environment — and that difference is the whole
  # bug. Both doors, or neither is shut.
  if command -v setsid >/dev/null 2>&1; then
    setsid env "${APPCTL_UNSET[@]}" "${env[@]}" "$APP/agentglass" "${args[@]}" </dev/null >/dev/null 2>&1 &
  else
    env "${APPCTL_UNSET[@]}" "${env[@]}" "$APP/agentglass" "${args[@]}" </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
  return 0
}

# Put back what a FAILED install took down, and say what state it left behind.
#
# The third member of the stop_app/start_app pair, and the one that was missing.
# install-local.sh stops the app because it is about to replace the files under
# it, and then every failure path below that point simply exited: a verification
# failure left the desktop with no app, no window and no line saying that was
# why. That happened today. `set -e` makes it the default outcome of any command
# that goes wrong down there, so the recovery has to live in a trap rather than
# be remembered at each exit.
#
# It lives here rather than inline in the installer for the same reason stop_app
# does: the interesting part is what it promises, and that is only testable
# against real processes (server/test/install-stop.test.ts).
#
# $1 exit code. $2 how far the install got, which decides what can honestly be
# claimed — the message it replaced said "nothing was left half-written" from
# both sides of the copy, and that is the same class of lie as a build stamp
# naming a commit it does not contain:
#   stopped   nothing was replaced; what is on disk is what was there before
#   replacing the copy was interrupted, so disk holds a mixture
#   replaced  the new files are down and did not verify
restore_after_failed_install() {
  local code="${1:-1}" phase="${2:-stopped}"
  echo "" >&2
  echo "The install FAILED (exit $code)." >&2
  case "$phase" in
    stopped)
      echo "Nothing was replaced — the app on disk is the one that was there before." >&2 ;;
    replacing)
      echo "It failed WHILE replacing the app's files, so what is on disk now is a" >&2
      echo "mixture. Reopening it may not work; fix the build and run this again and" >&2
      echo "it will be overwritten cleanly." >&2 ;;
    replaced)
      echo "The new files are already on disk and did not verify, so what is being" >&2
      echo "reopened is the build that just failed its checks, not the old one." >&2 ;;
  esac
  # start_app only ever replays an instance stop_app captured, so an install run
  # with the app already closed still leaves it closed — the person who closed
  # it meant to.
  if [ -z "${APPCTL_RESTART_ARGV:-}" ]; then
    echo "No app was running when this started, so none was reopened." >&2
    return 0
  fi
  echo "Putting back the instance this script stopped:" >&2
  start_app >&2 && return 0
  echo "  could not reopen it — start agentglass from your launcher" >&2
  return 1
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
    # Read it before signalling it. A process that has exited has no command
    # line left to read, and this is the only moment the answer exists.
    _capture_restart "$(echo "$mains" | head -n 1)"
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

# How many runs the deputy has going right now — 0 when nobody answers.
#
# `grep -o` exits 1 when it matches nothing, and this script runs under
# `set -euo pipefail`, so the honest answer "none" used to abort the caller
# before it printed anything: the install refused EXACTLY when it was safe,
# with no message, and a whole afternoon of work sat unpacked because of it.
#
# Counted with awk rather than `grep -c`: the run table arrives as one line, so
# grep would answer 1 for any number of runs, and "is anything running" is the
# only question here — but a wrong count is what gets printed at a person.
deputy_runs() {
  local body n
  body=$(curl -sf -m 4 "http://127.0.0.1:${AGENTGLASS_PORT:-4000}/understudy/work/next?token=${AGENTGLASS_TOKEN:-}" 2>/dev/null) || { echo 0; return 0; }
  n=$(printf '%s' "$body" | awk -v RS='"state":"running"' 'END{ print (NR > 0 ? NR - 1 : 0) }')
  echo "${n:-0}"
}

# Stopping the app kills the agent inside a run, and what it leaves is a branch
# with half a change on it and a row nobody can complete. Refused rather than
# warned: the damage is silent, and it shows up an hour later on somebody
# else's screen. AGENTGLASS_INSTALL_ANYWAY=1 is the way past it for a person
# who has decided the run does not matter.
refuse_if_deputy_busy() {
  [ -z "${AGENTGLASS_INSTALL_ANYWAY:-}" ] || return 0
  local runs
  runs=$(deputy_runs)
  [ "${runs:-0}" -gt 0 ] || return 0
  echo "refusing to install: the deputy has $runs run(s) going — stopping the app now kills the agent mid-change." >&2
  echo "  wait for it, halt it in the app, or AGENTGLASS_INSTALL_ANYWAY=1 make desktop-install" >&2
  return 1
}
