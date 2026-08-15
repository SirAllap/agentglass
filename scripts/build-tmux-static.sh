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
# `sha256sum` is GNU coreutils; macOS ships `shasum`. The release runners are
# both, and the first tag cut after these scripts landed died on a macOS runner
# with "sha256sum: command not found" — after downloading three tarballs.
# `nproc` is GNU; macOS has `sysctl -n hw.ncpu`. With neither, `make -j""` runs
# with NO limit — which is how the first macOS release build died: ncurses'
# makefiles raced and `make` reported "No rule to make target ../lib/libtinfo.a"
# for a library its own tree had not finished writing yet.
jobs_n() {
  nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

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
# KEEP_WORK=1 leaves the tree behind. A failing `configure` says "C compiler
# cannot create executables" and puts the actual reason in config.log, which the
# trap was deleting a millisecond later — two builds were guessed at before
# anybody could read one.
[ "${KEEP_WORK:-0}" = "1" ] || trap 'rm -rf "$WORK"' EXIT
echo "work dir: $WORK"
mkdir -p "$WORK/src" "$WORK/prefix" "$WORK/bin"

# zig is a compiler DRIVER: `zig cc` is the C compiler and the target has to be
# on every invocation. configure wants one executable in CC, so the two words
# become a one-line wrapper. `CC=zig` — what this said before it was ever run —
# hands configure a binary that only prints its own usage.
if [ "$CC" = "zig" ]; then
  printf '#!/bin/sh\nexec zig cc -target %s "$@"\n' "$TRIPLE" > "$WORK/bin/zcc"
  chmod +x "$WORK/bin/zcc"
  CC="$WORK/bin/zcc"
fi

fetch() { # name url
  # Split, not one `local`: with `set -u`, bash expands every word of a `local`
  # before it assigns any of them, so `file="$WORK/src/$name"` on the same line
  # reads a `name` that does not exist yet and the script dies on its first
  # call. Found by running the sibling script for Taskwarrior, which had been
  # copied from this one — this file had never been run.
  local name="$1"
  local url="$2"
  local file="$WORK/src/$name"
  [ -f "$file" ] || curl -fsSL -o "$file" "$url"
  echo "$file"
}

# --- checksums --------------------------------------------------------------
# Expected sha256s live in scripts/tmux-build-checksums.txt as
# "<sha256>  <name>". Missing or mismatching entries fail the build: a binary
# we ship into the app is a supply-chain decision, not a convenience.
CHECKSUMS="${TMUX_BUILD_CHECKSUMS:-scripts/tmux-build-checksums.txt}"
verify() { # file name
  local file="$1"
  local name="$2"
  local want
  want="$(awk -v n="$name" '$2==n {print $1; exit}' "$CHECKSUMS")"
  if [ -z "$want" ]; then
    echo "no pinned checksum for $name in $CHECKSUMS — refusing to build unverified" >&2
    exit 1
  fi
  local got; got="$(sha256_of "$file")"
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
    make -s -j"$(jobs_n)" && make -s install )
}

build_ncurses() {
  local t="$(fetch ncurses.tar.gz "$NCURSES_URL")"
  verify "$t" "ncurses-${NCURSES_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/ncurses-${NCURSES_VERSION}"
    # --without-progs/--without-tests keep the build tiny; the library is all
    # the pane engine needs.
    # `--with-termlib=tinfo` splits terminfo into its own archive under the
    # NARROW name, which is the one tmux's configure puts on the link line
    # (`-ltinfo`) even in a widec build. Without it everything compiles and the
    # final link is the only thing that fails, looking for a file ncurses was
    # never asked to make.
    CC="$CC" CFLAGS="-O2" ./configure --host="$TRIPLE" --prefix="$WORK/prefix" --without-shared --without-progs --without-tests --without-manpages --without-ada --disable-db-install --enable-widec --with-termlib=tinfo >/dev/null
    make -s -j"$(jobs_n)" && make -s install )
}

build_tmux() {
  local t="$(fetch tmux.tar.gz "$TMUX_URL")"
  verify "$t" "tmux-${TMUX_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/tmux-${TMUX_VERSION}"
    # Every line below is one continuation of a single command. A COMMENT
    # between two of them ENDS it, and the whole environment prefix is silently
    # dropped: configure then runs with the host gcc, none of these paths, and
    # reports "C compiler cannot create executables". That happened twice while
    # this was being written, the second time to the very comment explaining the
    # first. So the reasons live here, above the command, and the command has
    # nothing in it but continuations.
    #
    #   ac_cv_search_forkpty — musl HAS forkpty, in libc, with no separate
    #     `-lutil` for AC_SEARCH_LIBS to find. It gives up, `HAVE_FORKPTY` stays
    #     undefined, and compat.h declares its own prototype beside the real
    #     one: "conflicting types for 'forkpty'", forty files in.
    #   CPPFLAGS as well as CFLAGS — configure tests a header with the
    #     PREPROCESSOR, which reads CPPFLAGS. With only CFLAGS it says
    #     "accepted by the compiler, rejected by the preprocessor" and then
    #     decides libevent is missing.
    #   include/ncursesw — ncurses built `--enable-widec` puts its headers
    #     there, so `#include <ncurses.h>` finds nothing with only the prefix
    #     root on the path.
    #   -ltinfo — ncurses is built `--with-termlib=tinfo` above precisely so
    #     this archive exists under the name tmux's own configure uses.
    #   -static on the linker line (not -static-libgcc): everything in, no
    #     dependency on the host's libc either. `-s` strips at link time — the
    #     unstripped binary carries megabytes of DWARF into the app's download.
    ac_cv_search_forkpty="none required" \
    CC="$CC" \
    CFLAGS="-O2 -I$WORK/prefix/include -I$WORK/prefix/include/ncursesw -DHAVE_PROC_PID" \
    CPPFLAGS="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw" \
    LDFLAGS="-L$WORK/prefix/lib -static -s" \
    LIBS="-levent_core -levent -lncursesw -ltinfo -lm" \
    ./configure --host="$TRIPLE" --prefix="$WORK/prefix" >/dev/null
    make -s -j"$(jobs_n)" )
  file "$WORK/src/tmux-${TMUX_VERSION}/tmux"
}

[ "${SKIP_NCURSES:-0}" = "1" ] || build_ncurses
build_libevent
build_tmux

mkdir -p out
cp "$WORK/src/tmux-${TMUX_VERSION}/tmux" "out/tmux-$TARGET"
chmod +x "out/tmux-$TARGET"

# Proof rather than hope — and only where it can run: a cross-built arm64 binary
# on an x64 host is the point of cross-building, not a failure. Where it cannot
# be run, `file` is the check, and "statically linked" is the property that
# decides whether this works on a machine that is not this one.
HOST_ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
HOST_OS="$(uname -s | tr 'A-Z' 'a-z')"
if [ "$TARGET" = "bun-$HOST_OS-$HOST_ARCH" ]; then
  "out/tmux-$TARGET" -V
else
  echo "  cross-built for $TARGET — not run here"
fi
file "out/tmux-$TARGET" | sed 's/^/  /'
case "$(file -b "out/tmux-$TARGET")" in
  *"statically linked"*) ;;
  *) echo "NOT STATIC — this would depend on the host's libc" >&2; exit 1 ;;
esac
echo "built out/tmux-$TARGET"
