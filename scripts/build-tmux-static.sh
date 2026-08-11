#!/usr/bin/env bash
# Build a fully static tmux for one target, for bundling into the app.
#
# The pane engine's tmux is an implementation detail of the agentglass UI, so
# the desktop app and headless installs ship their own rather than depending on
# the system one. This script produces that binary:
#
#   ./scripts/build-tmux-static.sh            # host arch, ./out/tmux-<target>
#   TARGET=bun-linux-arm64 ./scripts/build-tmux-static.sh
#   SKIP_NCURSES=1 ...                        # reuse a previous ncurses build
#
# Targets (match the sidecar's bun targets):
#   bun-linux-x64      musl static   (zig cc)
#   bun-linux-arm64    musl static   (zig cc)
#   bun-darwin-arm64   clang static  (macOS SDK via clang)
#   bun-darwin-x64     clang static
#
# Requirements: curl, tar, a C toolchain. Linux targets additionally need
# zig (https://ziglang.org) on PATH; darwin targets use the system clang.
# Everything is pinned below; the checksums file is the one thing CI can refuse
# to build without, and a mismatch fails the build loudly rather than shipping
# an unverified binary.
#
# The result is statically linked (musl on Linux, full static on macOS) so the
# bundled binary has no libevent/ncurses dependency on the host — that is what
# makes "no tmux on the machine" irrelevant to the engine.
set -euo pipefail
cd "$(dirname "$0")/.."

TMUX_VERSION=3.5a
LIBEVENT_VERSION=2.1.12
NCURSES_VERSION=6.5
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}-stable/libevent-${LIBEVENT_VERSION}-stable.tar.gz"
NCURSES_URL="https://invisible-island.net/archives/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"

TARGET="${TARGET:-$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')}"
case "$TARGET" in
  bun-linux-x64)   CC=zig;       TRIPLE="x86_64-linux-musl"; HOST=x86_64-linux-musl ;;
  bun-linux-arm64) CC=zig;       TRIPLE="aarch64-linux-musl"; HOST=aarch64-linux-musl ;;
  bun-darwin-arm64) CC=clang;    TRIPLE="arm64-apple-darwin"; HOST=arm64-apple-darwin ;;
  bun-darwin-x64)  CC=clang;     TRIPLE="x86_64-apple-darwin"; HOST=x86_64-apple-darwin ;;
  *) echo "unknown target $TARGET (expected bun-linux-{x64,arm64} or bun-darwin-{x64,arm64})" >&2; exit 1 ;;
esac

WORK="$(mktemp -d /tmp/tmux-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src" "$WORK/prefix"

fetch() { # name url
  local name="$1" url="$2" file="$WORK/src/$name"
  [ -f "$file" ] || curl -fsSL -o "$file" "$url"
  echo "$file"
}

# --- checksums --------------------------------------------------------------
# Expected sha256s live in scripts/tmux-build-checksums.txt as
# "<sha256>  <name>". Missing or mismatching entries fail the build: a binary
# we ship into the app is a supply-chain decision, not a convenience.
CHECKSUMS="${TMUX_BUILD_CHECKSUMS:-scripts/tmux-build-checksums.txt}"
verify() { # file name
  local file="$1" name="$2" want
  want="$(awk -v n="$name" '$2==n {print $1; exit}' "$CHECKSUMS")"
  if [ -z "$want" ]; then
    echo "no pinned checksum for $name in $CHECKSUMS — refusing to build unverified" >&2
    exit 1
  fi
  local got; got="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $name: got $got, want $want" >&2
    exit 1
  fi
}

build_libevent() {
  local t="$(fetch libevent.tar.gz "$LIBEVENT_URL")"
  verify "$t" "libevent-${LIBEVENT_VERSION}-stable.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/libevent-${LIBEVENT_VERSION}-stable"
    CC="$CC" ./configure --host="$TRIPLE" --prefix="$WORK/prefix" --disable-shared --enable-static --disable-openssl --disable-samples --disable-libevent-regress >/dev/null
    make -s -j"$(nproc)" && make -s install )
}

build_ncurses() {
  local t="$(fetch ncurses.tar.gz "$NCURSES_URL")"
  verify "$t" "ncurses-${NCURSES_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/ncurses-${NCURSES_VERSION}"
    # --without-progs/--without-tests keep the build tiny; the library is all
    # the pane engine needs.
    CC="$CC" CFLAGS="-O2" ./configure --host="$TRIPLE" --prefix="$WORK/prefix" --without-shared --without-progs --without-tests --without-manpages --without-ada --disable-db-install --enable-widec >/dev/null
    make -s -j"$(nproc)" && make -s install )
}

build_tmux() {
  local t="$(fetch tmux.tar.gz "$TMUX_URL")"
  verify "$t" "tmux-${TMUX_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/tmux-${TMUX_VERSION}"
    # -static on the linker line (not -static-libgcc): everything in, no
    # dependency on the host's libc either. LDFLAGS and CFLAGS both carry the
    # prefix because tmux's configure probes with both.
    CC="$CC" \
    CFLAGS="-O2 -I$WORK/prefix/include -DHAVE_PROC_PID" \
    LDFLAGS="-L$WORK/prefix/lib -static" \
    LIBS="-levent_core -levent -lncursesw -ltinfo -lm" \
    ./configure --host="$TRIPLE" --prefix="$WORK/prefix" >/dev/null
    make -s -j"$(nproc)" )
  file "$WORK/src/tmux-${TMUX_VERSION}/tmux"
}

[ "${SKIP_NCURSES:-0}" = "1" ] || build_ncurses
build_libevent
build_tmux

mkdir -p out
cp "$WORK/src/tmux-${TMUX_VERSION}/tmux" "out/tmux-$TARGET"
chmod +x "out/tmux-$TARGET"
echo "built out/tmux-$TARGET"
