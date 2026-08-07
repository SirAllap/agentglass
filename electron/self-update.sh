#!/usr/bin/env bash
# Build and install a released tag, then restart the app.
#
# Spawned detached by the server, because installing stops the running app — so
# this script's parent dies halfway through, on purpose. It reports by writing a
# log and a result stamp that the next instance reads back, rather than to a
# caller that will not be there.
#
# It works in its OWN clone under ~/.cache, never in a developer's checkout.
# That is what makes checking out a tag safe here: nothing in this directory is
# ever edited, so there is no work to lose and no HEAD anyone cares about.
set -uo pipefail

LOG="${AGENTGLASS_UPDATE_LOG:-/tmp/agentglass-update.log}"
STAMP="${AGENTGLASS_UPDATE_STAMP:-$HOME/.cache/agentglass/last-update.json}"
SRC="${AGENTGLASS_UPDATE_SRC:-$HOME/.cache/agentglass/source}"
TAG="${AGENTGLASS_UPDATE_TAG:-}"
ORIGIN="${AGENTGLASS_UPDATE_ORIGIN:-}"

mkdir -p "$(dirname "$STAMP")" "$(dirname "$SRC")" 2>/dev/null || true
exec >>"$LOG" 2>&1

say() { printf '\n==> %s\n' "$*"; }

# Written on every exit path, including the ones nobody planned for: an update
# that vanishes without a word is worse than one that reports failure.
finish() {
  local ok="$1" tail
  tail="$(tail -c 1200 "$LOG" 2>/dev/null | sed 's/"/\\"/g' | tr '\n' '~' || true)"
  printf '{"at":"%s","ok":%s,"tail":"%s"}\n' "$(date -Is)" "$ok" "$tail" > "$STAMP" 2>/dev/null || true
}
fail() { say "FAILED: $*"; finish false; exit 1; }

[ -n "$TAG" ] || fail "no tag given"
[ -n "$ORIGIN" ] || fail "no origin given"
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  # The tag reaches git as an argument, so it is checked here as well as in the
  # server. One validation is a policy; two is a boundary.
  *) fail "refusing a tag that is not a release: $TAG" ;;
esac

export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS_REQUIRE=never

if [ -d "$SRC/.git" ]; then
  say "updating the update clone at $SRC"
  git -C "$SRC" remote set-url origin "$ORIGIN" || fail "cannot set origin"
  git -C "$SRC" fetch --quiet --tags --prune origin || fail "cannot reach $ORIGIN"
else
  say "cloning $ORIGIN into $SRC (first update only)"
  rm -rf "$SRC"
  git clone --quiet "$ORIGIN" "$SRC" || fail "cannot clone $ORIGIN"
fi

say "checking out $TAG"
# Discards anything in this clone without a thought, which is safe precisely
# because it is ours: a half-applied previous run must not survive into this one.
git -C "$SRC" reset --hard --quiet HEAD
git -C "$SRC" clean -qfd
git -C "$SRC" checkout --quiet --detach "refs/tags/$TAG" || fail "no such tag: $TAG"
say "now at $(git -C "$SRC" rev-parse --short HEAD) ($TAG)"

say "installing dependencies"
( cd "$SRC/web" && bun install --silent ) || fail "web dependencies failed"
( cd "$SRC/electron" && bun install --silent ) || fail "electron dependencies failed"

say "building and installing (this stops the running app)"
# The old wording here promised "the installed app is untouched", which was only
# true for a failure before the copy — install-local.sh replaces the files
# halfway through. It now reports which side of that line it stopped on, and
# reopens whatever it took down, so the honest thing to say is "read the log".
bash "$SRC/electron/install-local.sh" || fail "build or install failed — see the lines above for what state the install was left in"

BIN="$HOME/.local/bin/agentglass"
APP="$HOME/.local/share/agentglass-desktop"

# Did the installer put the app back?
#
# This used to launch one unconditionally, and install-local.sh has ended with
# start_app since 22 July, so every update from the button started TWO apps a
# millisecond apart and let requestSingleInstanceLock (electron/main.js) decide
# which of them lived. Harmless while the two were identical; not harmless once
# they stopped being. Measured over 20 runs against the real binary: 1.2–1.6 ms
# between the launches, 79–101 ms of spread in when they reached the lock, and
# the second one won 12 times out of 20. A coin flip, in other words, and the
# side that wins here is the WRONG one — it is a bare launch, with none of the
# arguments or the scoping that stop_app captured off the instance it stopped.
#
# So this now only opens the app when nothing came back, which is the one case
# the installer deliberately does not cover: it reopens what it took down, and
# takes nothing down if nothing was running. Pressing Update in a window that
# has since died should still leave an app open.
#
# From the clone, because that is where install-local.sh sourced it from too.
WHY="nothing was running when this finished"
if [ -f "$SRC/electron/appctl.sh" ]; then
  # shellcheck source=appctl.sh
  . "$SRC/electron/appctl.sh"
  # Bounded, because start_app's `setsid env … agentglass` spends its first
  # instants as /usr/bin/env, and main_pids matches on the binary behind the
  # pid. Asking too early answers "nothing came back" about an app that did.
  for _ in $(seq 40); do [ -n "$(main_pids)" ] && break; sleep 0.1; done
  if [ -n "$(main_pids)" ]; then
    say "done — running $TAG (the install reopened it)"
    finish true
    exit 0
  fi
else
  # Say which of the two this is. Without appctl.sh there is no way to ask
  # whether an app came back, and reporting a check that never ran as though it
  # had is the same class of lie as an installer printing "installed:" over a
  # copy that failed.
  WHY="could not tell whether the install reopened anything"
fi

say "$WHY — opening $TAG"
if [ -x "$BIN" ]; then
  # Its own session, so the app does not die along with this script.
  setsid nohup "$BIN" >/dev/null 2>&1 </dev/null &
  say "done — running $TAG"
  finish true
else
  fail "installed, but $BIN is missing — start it from your launcher"
fi
