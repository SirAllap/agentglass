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

# Splitting terminfo out of ncurses is a Linux answer to a Linux problem, and
# it does not survive the crossing. On the release runner both macOS jobs died
# inside ncurses' own tree with "No rule to make target `../lib/libtinfo.a`":
# with `--enable-widec` the archive it writes is `libtinfow.a`, and the rule
# asking for the narrow name never gets an answer. Linux, cross-compiled with
# zig against musl, does produce `libtinfo.a` — which is why this only ever
# broke on one side.
#
# So the split, and the `-ltinfo` that goes with it, are asked for only where
# they work. On darwin, ncurses keeps terminfo inside `libncursesw` and tmux
# links that one library, which is what a native build there does anyway.
case "$TARGET" in
  *linux*)  NCURSES_TERMLIB="--with-termlib=tinfo"; TINFO_LDLIB="-ltinfo" ;;
  *darwin*) NCURSES_TERMLIB="";                     TINFO_LDLIB=""        ;;
esac

# How far "static" goes, and how the target is named — both differ on darwin,
# and both were assumed to be the Linux answer.
#
#   -static: there is no static libSystem on macOS and the linker refuses to
#     pretend otherwise, which reaches `configure` as the flat "C compiler
#     cannot create executables". What the app actually needs is no dependency
#     on a tmux, libevent or ncurses the user may not have — and those are
#     already `.a` archives built right here, so they link in either way.
#     libSystem stays dynamic, as it does for every binary on that platform.
#   -s: a linker flag on GNU ld, obsolete on Apple's. `-Wl,-x` is the local
#     symbol strip that means the same thing here.
#   --host: tmux 3.5a's `config.sub` does not know `arm64-apple-darwin` and
#     stops the build with "config.sub … failed". A native build does not need
#     to be told what it is; `-arch` is what decides the slice, and it is the
#     one thing the x64 job needs to say out loud on an arm64 runner.
case "$TARGET" in
  *linux*)          LDMODE="-static -s"; ARCHFLAG="";              HOSTFLAG="--host=$TRIPLE" ;;
  bun-darwin-arm64) LDMODE="-Wl,-x";     ARCHFLAG="-arch arm64";   HOSTFLAG=""               ;;
  bun-darwin-x64)   LDMODE="-Wl,-x";     ARCHFLAG="-arch x86_64";  HOSTFLAG=""               ;;
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
    CC="$CC" ./configure $HOSTFLAG --prefix="$WORK/prefix" --disable-shared --enable-static --disable-openssl --disable-samples --disable-libevent-regress >/dev/null
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
    CC="$CC" CFLAGS="-O2 $ARCHFLAG" LDFLAGS="$ARCHFLAG" ./configure $HOSTFLAG --prefix="$WORK/prefix" --without-shared --without-progs --without-tests --without-manpages --without-ada --disable-db-install --enable-widec $NCURSES_TERMLIB >/dev/null
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
    #   --disable-utf8proc — darwin's configure refuses to guess and stops with
    #     "must give --enable-utf8proc or --disable-utf8proc", which is where
    #     both mac jobs of the v0.12.0 tag died once the ncurses fixes let them
    #     reach it. Linux does not ask and settles on disabled anyway, so this
    #     says out loud on every platform what one of them was already doing.
    #     Enabling it would mean vendoring a third library.
    #
    #     It goes on the ./configure line and NOT here: every line in this block
    #     ends in a backslash, so a comment placed among them is joined onto the
    #     assignment above it and swallows the rest — configure then runs on its
    #     own with none of these flags, finds neither libevent nor ncurses, and
    #     the linux build that had been passing breaks. `bash -n` reads that as
    #     valid, because it is; it is just not the command anybody wrote.
    ac_cv_search_forkpty="none required" \
    CC="$CC" \
    CFLAGS="-O2 $ARCHFLAG -I$WORK/prefix/include -I$WORK/prefix/include/ncursesw -DHAVE_PROC_PID" \
    CPPFLAGS="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw" \
    LDFLAGS="-L$WORK/prefix/lib $ARCHFLAG $LDMODE" \
    LIBS="-levent_core -levent -lncursesw $TINFO_LDLIB -lm" \
    ./configure $HOSTFLAG --disable-utf8proc --prefix="$WORK/prefix" >/dev/null
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

# What "static enough" means, which is not the same sentence on both platforms.
#
# The property this build actually needs is that the binary runs on a machine
# that has no tmux, no libevent and no ncurses — those three are built here as
# .a archives and linked in. It is NOT "depends on nothing at all".
#
#   linux  — `-static` really does take libc too, and `file` says so. The string
#            is the proof, and it stays the check.
#   darwin — there is no static libSystem and the linker refuses to pretend
#            otherwise, which is why LDMODE drops `-static` there (see the case
#            near the top, and #531). `file` therefore never says "statically
#            linked" on a Mach-O, and this check demanded it anyway: the mac
#            builds compiled a working tmux, ran it, printed `tmux 3.5a`, and
#            then failed on their own verification. So ask otool what is
#            actually linked and require all of it to be the system's.
case "$TARGET" in
  *darwin*)
    deps="$(otool -L "out/tmux-$TARGET" | tail -n +2 | awk '{print $1}')"
    echo "$deps" | sed 's/^/  links: /'
    # Anything outside /usr/lib and /System is a library the user would have to
    # already have — libevent and ncursesw are the ones this script builds, and
    # seeing either here means the .a archives were not the thing that got used.
    stray="$(echo "$deps" | grep -vE '^(/usr/lib/|/System/Library/)' || true)"
    if [ -n "$stray" ]; then
      echo "NOT SELF-CONTAINED — links libraries the user may not have:" >&2
      echo "$stray" | sed 's/^/  /' >&2
      exit 1
    fi
    ;;
  *)
    case "$(file -b "out/tmux-$TARGET")" in
      *"statically linked"*) ;;
      *) echo "NOT STATIC — this would depend on the host's libc" >&2; exit 1 ;;
    esac
    ;;
esac
echo "built out/tmux-$TARGET"
