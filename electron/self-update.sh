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

LOG="${AGENTGLASS_UPDATE_LOG:-$HOME/.cache/agentglass/update.log}"
STAMP="${AGENTGLASS_UPDATE_STAMP:-$HOME/.cache/agentglass/last-update.json}"
SRC="${AGENTGLASS_UPDATE_SRC:-$HOME/.cache/agentglass/source}"
TAG="${AGENTGLASS_UPDATE_TAG:-}"
ORIGIN="${AGENTGLASS_UPDATE_ORIGIN:-}"
# Overridable so a test can point this at a throwaway key instead of the real
# pinned one; unset in every real install, where the default (beside this
# script) is the only path that matters.
ALLOWED_SIGNERS_OVERRIDE="${AGENTGLASS_UPDATE_ALLOWED_SIGNERS:-}"

mkdir -p "$(dirname "$STAMP")" "$(dirname "$SRC")" "$(dirname "$LOG")" 2>/dev/null || true
# The log carries paths and git output, so it is created private and lives under
# the user's own cache — a fixed name in a shared directory is a name anyone can
# plant a link at. Only the log is made 0600: a umask here would reach the build.
( umask 077; : >>"$LOG" ) 2>/dev/null; chmod 600 "$LOG" 2>/dev/null || true
exec >>"$LOG" 2>&1

say() { printf '\n==> %s\n' "$*"; }

# install-local.sh's low_priority, duplicated here: the same 5 lines, meant to
# stay identical. The web and electron installs below are minutes of CPU and
# disk on a machine whose agents are still running.
low_priority() {
  if command -v nice >/dev/null 2>&1; then set -- nice -n 10 "$@"; fi
  if command -v ionice >/dev/null 2>&1; then set -- ionice -c3 "$@"; fi
  "$@"
}

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

# This runs with the app's environment, and the app has whatever the shell that
# last opened it exported. A real update built into another session's
# scratchpad that way: AGENTGLASS_DIST_DIR sends electron-builder's output
# anywhere it names, and a TMPDIR that is some other process's temp dir can be
# gone by the time the build wants it. Without them the build lands in the
# update clone under ~/.cache/agentglass and temp files go where they go for
# everything else, and the app the install reopens carries neither.
unset AGENTGLASS_DIST_DIR TMPDIR CLAUDE_CODE_TMPDIR

if [ -d "$SRC/.git" ]; then
  say "updating the update clone at $SRC"
  git -C "$SRC" remote set-url origin "$ORIGIN" || fail "cannot set origin"
  git -C "$SRC" fetch --quiet --tags --prune origin || fail "cannot reach $ORIGIN"
else
  say "cloning $ORIGIN into $SRC (first update only)"
  rm -rf "$SRC"
  git clone --quiet "$ORIGIN" "$SRC" || fail "cannot clone $ORIGIN"
fi

say "checking the tag $TAG"
# What this builds is whatever the tag names once it is fetched, so the tag is
# pinned to a commit here and the checkout is held to it. An annotated tag is
# what release.yml cuts. A lightweight tag is refused too, which rules out the
# seven releases before v0.16.0 — updating goes forward to the newest tag, so
# it is not a path anyone takes.
[ "$(git -C "$SRC" for-each-ref --format='%(objecttype)' "refs/tags/$TAG")" = tag ] \
  || fail "$TAG is not an annotated release tag"
WANT="$(git -C "$SRC" rev-parse "refs/tags/$TAG^{commit}")" || fail "cannot resolve $TAG"
# The tag OBJECT's own "tag <name>" header must name $TAG, not merely the ref
# path used to fetch it: without this, a compromised origin can publish an
# older, legitimately-signed tag object under a brand-new ref name (refs/tags/
# v9.99.0, say) and every install "updates" backward to it — the signature
# verifies fine, because it is real, just for a different release than the
# one this ref claims to be.
GOT_NAME="$(git -C "$SRC" cat-file tag "refs/tags/$TAG" | sed -n 's/^tag //p;/^$/q')"
[ "$GOT_NAME" = "$TAG" ] \
  || fail "the signed tag object names \"$GOT_NAME\", not $TAG — refusing a renamed or replayed tag"
# The signature has to verify against ONE pinned key, shipped next to this
# script rather than trusted from whatever gpg/ssh already knows on this
# machine — `git verify-tag` alone answers "does a signature verify against
# some key the local trust store already has", which is a question an
# attacker who can get their own key trusted (or a machine with a stray key
# already configured) answers just as well as the real signer. Read from
# beside THIS script (its own install, or the dev checkout), never from
# inside $SRC: that clone is exactly the thing under test, and a compromised
# origin could otherwise ship its own allowed-signers file alongside a forged
# signature and pass its own check.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED_SIGNERS="${ALLOWED_SIGNERS_OVERRIDE:-$SCRIPT_DIR/release-allowed-signers}"
[ -f "$ALLOWED_SIGNERS" ] || fail "no pinned release-signing key at $ALLOWED_SIGNERS — cannot verify $TAG"
# Every non-SSH verifier disabled outright, not merely `gpg.format=ssh`: that
# setting alone governs how git SIGNS, not how `verify-tag` picks a verifier
# for an EXISTING signature, which it still does by sniffing the armor block
# itself. Measured: a tag object carrying a real PGP signature, PLUS the
# literal text "-----BEGIN SSH SIGNATURE-----" sitting harmlessly in its free-
# text message, passed a grep-then-verify sequence that checked "is this
# tag signed at all" by grepping the WHOLE object for that marker (true, by
# accident) and then let `git verify-tag` shell out to gpg for the real PGP
# block — which happily verified against a key from the local keyring that
# was never anywhere near ALLOWED_SIGNERS. Disabling gpg/x509 as verifier
# programs makes an SSH-format signature the only kind `verify-tag` can ever
# succeed on, so there is no format left for an attacker to switch to.
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" \
    -c gpg.program=false -c gpg.openpgp.program=false -c gpg.x509.program=false \
    -C "$SRC" verify-tag "refs/tags/$TAG" >/dev/null 2>&1 \
  || fail "refusing $TAG: no valid SSH signature from the pinned release key"

say "checking out $TAG"
# Discards anything in this clone without a thought, which is safe precisely
# because it is ours: a half-applied previous run must not survive into this one.
git -C "$SRC" reset --hard --quiet HEAD
git -C "$SRC" clean -qfd
git -C "$SRC" checkout --quiet --detach "refs/tags/$TAG" || fail "no such tag: $TAG"
[ "$(git -C "$SRC" rev-parse HEAD)" = "$WANT" ] || fail "the checkout is not the commit $TAG names"
say "now at $(git -C "$SRC" rev-parse --short HEAD) ($TAG)"

say "installing dependencies"
( cd "$SRC/web" && low_priority bun install --frozen-lockfile --silent ) || fail "web dependencies failed"
( cd "$SRC/electron" && low_priority bun install --frozen-lockfile --silent ) || fail "electron dependencies failed"

say "building and installing (this stops the running app)"
# The build itself is install-local.sh, which wraps its own heavy children; this
# call carries the restart at the end, which must stay at normal priority.
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
