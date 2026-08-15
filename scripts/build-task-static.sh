#!/usr/bin/env bash
# Build a fully static Taskwarrior for one target, for bundling into the app.
#
# Local tasks are an agentglass feature, so the desktop app and headless
# installs should ship their own `task` rather than requiring the user to go and
# install one — exactly the argument build-tmux-static.sh makes for the pane
# engine's tmux, and this script is deliberately its sibling in shape.
#
#   ./scripts/build-task-static.sh             # host arch, ./out/task-<target>
#   TARGET=bun-linux-arm64 ./scripts/build-task-static.sh
#   SKIP_UUID=1 ...                            # reuse a previous libuuid build
#
# Targets (match the sidecar's bun targets, and tmux's):
#   bun-linux-x64      musl static   (zig cc)
#   bun-linux-arm64    musl static   (zig cc)
#   bun-darwin-arm64   clang         (macOS SDK via clang)
#   bun-darwin-x64     clang
#   host               the system compiler, `-static`. Not for shipping — this
#                      is the one a developer can run without zig, to prove the
#                      recipe before CI builds the four real ones.
#
# WHY 2.6.2 AND NOT 3.x — this is the load-bearing decision in the file.
# Taskwarrior 3 replaced the flat `.data` files with TaskChampion's SQLite
# store, and opening an existing 2.x store with a 3.x binary MIGRATES it, in
# place, with no way back. Shipping a 3.x binary would therefore convert the
# store of every user who already has Taskwarrior 2 the first time agentglass
# happened to run — a data migration nobody asked for, performed by a tool they
# did not know was there. 2.6.2 reads and writes what is already on their disk.
#
# Requirements: curl, cmake, a C++ toolchain. Linux cross targets additionally
# need zig (https://ziglang.org) on PATH. Everything is pinned in
# scripts/task-build-checksums.txt, and the build refuses to run without an
# entry for every tarball: a binary the app ships is a supply-chain decision,
# not a convenience.
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

TASK_VERSION=2.6.2
UUID_VERSION=2.39.3
TASK_URL="https://github.com/GothenburgBitFactory/taskwarrior/releases/download/v${TASK_VERSION}/task-${TASK_VERSION}.tar.gz"
UUID_URL="https://www.kernel.org/pub/linux/utils/util-linux/v2.39/util-linux-${UUID_VERSION}.tar.gz"

TARGET="${TARGET:-host}"
case "$TARGET" in
  bun-linux-x64)    CC=zig;  CXX=zig; TRIPLE="x86_64-linux-musl"; NEEDS_UUID=1 ;;
  bun-linux-arm64)  CC=zig;  CXX=zig; TRIPLE="aarch64-linux-musl"; NEEDS_UUID=1 ;;
  bun-darwin-arm64) CC=clang; CXX=clang++; TRIPLE="arm64-apple-darwin"; NEEDS_UUID=0 ;;
  bun-darwin-x64)   CC=clang; CXX=clang++; TRIPLE="x86_64-apple-darwin"; NEEDS_UUID=0 ;;
  host)             CC=cc;   CXX=c++;  TRIPLE=""; NEEDS_UUID=0 ;;
  *) echo "unknown target $TARGET (expected host, bun-linux-{x64,arm64} or bun-darwin-{x64,arm64})" >&2; exit 1 ;;
esac

WORK="$(mktemp -d /tmp/task-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src" "$WORK/prefix" "$WORK/bin"

# zig is a compiler DRIVER, not a compiler: `zig cc` is the C one and `zig c++`
# the C++ one, and both need the target on every invocation. autotools and cmake
# both want a single executable in CC/CXX, so the two words become two one-line
# wrappers. (Writing `CC=zig` — which is what this script said before it was
# ever run — makes configure probe a binary that only prints its own usage.)
if [ "$CC" = "zig" ]; then
  printf '#!/bin/sh\nexec zig cc -target %s "$@"\n' "$TRIPLE" > "$WORK/bin/zcc"
  printf '#!/bin/sh\nexec zig c++ -target %s "$@"\n' "$TRIPLE" > "$WORK/bin/zxx"
  chmod +x "$WORK/bin/zcc" "$WORK/bin/zxx"
  CC="$WORK/bin/zcc"
  CXX="$WORK/bin/zxx"
fi

fetch() { # name url
  # Split, not one `local`: with `set -u`, bash expands every word of a `local`
  # before it assigns any of them, so `file="$WORK/src/$name"` on the same line
  # reads a `name` that does not exist yet and the script dies on its own
  # first call.
  local name="$1"
  local url="$2"
  local file="$WORK/src/$name"
  [ -f "$file" ] || curl -fsSL -o "$file" "$url"
  echo "$file"
}

# --- checksums --------------------------------------------------------------
CHECKSUMS="${TASK_BUILD_CHECKSUMS:-scripts/task-build-checksums.txt}"
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

# libuuid, from util-linux.
#
# Only for the musl cross targets. Taskwarrior wants uuid_unparse_lower on Linux
# and nothing else from the package, so everything but the one library is turned
# off — building the whole of util-linux for a 40kB archive would double the time
# this takes for no gain. macOS has it in libSystem, and the host build finds the
# distribution's own static archive, which is why `host` asks for neither.
build_uuid() {
  local t; t="$(fetch util-linux.tar.gz "$UUID_URL")"
  verify "$t" "util-linux-${UUID_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/util-linux-${UUID_VERSION}"
    CC="$CC" ./configure ${TRIPLE:+--host="$TRIPLE"} --prefix="$WORK/prefix" \
      --disable-all-programs --enable-libuuid --disable-shared --enable-static \
      --without-python --without-systemd --without-udev >/dev/null
    make -s -j"$(jobs_n)" && make -s install )
}

build_task() {
  local t; t="$(fetch task.tar.gz "$TASK_URL")"
  verify "$t" "task-${TASK_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/task-${TASK_VERSION}"
    # `-s` strips at link time. Measured: the musl build is 34MB with debug
    # info and 5MB without, and this binary ships inside the app's download —
    # 29MB of DWARF nobody will ever open is not a rounding error.
    #
    # ENABLE_SYNC=OFF drops the gnutls dependency outright. The sync server is
    # not something agentglass drives, and a TLS stack is the single largest
    # thing that would have to be built and kept patched to ship this.
    cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_SYNC=OFF \
      -DCMAKE_C_COMPILER="$CC" \
      -DCMAKE_CXX_COMPILER="$CXX" \
      -DCMAKE_INCLUDE_PATH="$WORK/prefix/include" \
      -DCMAKE_LIBRARY_PATH="$WORK/prefix/lib" \
      -DCMAKE_EXE_LINKER_FLAGS="-static -s -L$WORK/prefix/lib" \
      >/dev/null
    # No `--target task`: 2.6.2 names its executable target differently from
    # the binary, and asking for one that does not exist ends with cmake
    # cheerfully doing nothing and the copy below failing on a missing file.
    cmake --build build -j"$(jobs_n)" >/dev/null )
}

[ "$NEEDS_UUID" = "1" ] && [ "${SKIP_UUID:-0}" != "1" ] && build_uuid
build_task

BIN="$WORK/src/task-${TASK_VERSION}/build/src/task"
mkdir -p out
cp "$BIN" "out/task-$TARGET"
chmod +x "out/task-$TARGET"

# Proof rather than hope: a binary that cannot answer `--version` is not one to
# ship, and "it linked" is not the same claim.
#
# Only where it CAN run, though: a cross-built arm64 binary on an x64 host is not
# a failure, it is the point of cross-building — and `Exec format error` killing
# the script here threw away a twenty-minute build that had succeeded. Where it
# cannot be run, `file` is the check: the architecture and "statically linked"
# are exactly what a bundled binary has to get right, and both are readable
# without executing anything.
HOST_ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
HOST_OS="$(uname -s | tr 'A-Z' 'a-z')"
if [ "$TARGET" = host ] || [ "$TARGET" = "bun-$HOST_OS-$HOST_ARCH" ]; then
  "out/task-$TARGET" --version
else
  echo "  cross-built for $TARGET — not run here"
fi
file "out/task-$TARGET" | sed 's/^/  /'
case "$(file -b "out/task-$TARGET")" in
  *"statically linked"*) ;;
  *) echo "NOT STATIC — this would depend on the host's libc" >&2; exit 1 ;;
esac
echo "built out/task-$TARGET"
