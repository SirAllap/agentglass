#!/usr/bin/env bash
# One-time bootstrap: compute the pinned checksums for build-tmux-static.sh.
#
# The build refuses tarballs without a pin, and pins have to come from the
# actual downloads — so the first networked build on a fresh checkout fills
# this file, and every build after that verifies against it. A mismatch (the
# version bumped, a mirror tampered) fails loudly. Idempotent: does nothing
# once every pin exists, so CI can call it unconditionally.
# `sha256sum` is GNU coreutils; macOS ships `shasum`. The release runners are
# both, and the first tag cut after these scripts landed died on a macOS runner
# with "sha256sum: command not found" — after downloading three tarballs.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

set -euo pipefail
cd "$(dirname "$0")/.."

CH="${TMUX_BUILD_CHECKSUMS:-scripts/tmux-build-checksums.txt}"
TMUX_VERSION=3.5a
LIBEVENT_VERSION=2.1.12
NCURSES_VERSION=6.5

need() { # name url
  local name="$1" url="$2"
  if awk -v n="$name" '$2==n {found=1} END {exit !found}' "$CH" 2>/dev/null; then
    return 0
  fi
  local tmp; tmp="$(mktemp /tmp/tmux-sha.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL -o "$tmp" "$url"
  local sum; sum="$(sha256_of "$tmp")"
  printf '%s  %s\n' "$sum" "$name" >> "$CH"
  rm -f "$tmp"
  trap - EXIT
}

need "tmux-${TMUX_VERSION}.tar.gz" "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
need "libevent-${LIBEVENT_VERSION}-stable.tar.gz" "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}-stable/libevent-${LIBEVENT_VERSION}-stable.tar.gz"
need "ncurses-${NCURSES_VERSION}.tar.gz" "https://invisible-island.net/archives/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"
echo "tmux build checksums pinned in $CH"
