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
bash "$SRC/electron/install-local.sh" || fail "build or install failed — the installed app is untouched"

say "relaunching"
BIN="$HOME/.local/bin/agentglass"
if [ -x "$BIN" ]; then
  # Its own session, so the app does not die along with this script.
  setsid nohup "$BIN" >/dev/null 2>&1 </dev/null &
  say "done — running $TAG"
  finish true
else
  fail "installed, but $BIN is missing — start it from your launcher"
fi
