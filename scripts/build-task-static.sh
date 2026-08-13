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
mkdir -p "$WORK/src" "$WORK/prefix"

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
  local got; got="$(sha256sum "$file" | awk '{print $1}')"
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
    ./configure ${TRIPLE:+--host="$TRIPLE"} --prefix="$WORK/prefix" \
      --disable-all-programs --enable-libuuid --disable-shared --enable-static \
      --without-python --without-systemd --without-udev >/dev/null
    make -s -j"$(nproc)" && make -s install )
}

build_task() {
  local t; t="$(fetch task.tar.gz "$TASK_URL")"
  verify "$t" "task-${TASK_VERSION}.tar.gz"
  tar -xzf "$t" -C "$WORK/src"
  ( cd "$WORK/src/task-${TASK_VERSION}"
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
      -DCMAKE_EXE_LINKER_FLAGS="-static -L$WORK/prefix/lib" \
      >/dev/null
    # No `--target task`: 2.6.2 names its executable target differently from
    # the binary, and asking for one that does not exist ends with cmake
    # cheerfully doing nothing and the copy below failing on a missing file.
    cmake --build build -j"$(nproc)" >/dev/null )
}

[ "$NEEDS_UUID" = "1" ] && [ "${SKIP_UUID:-0}" != "1" ] && build_uuid
build_task

BIN="$WORK/src/task-${TASK_VERSION}/build/src/task"
mkdir -p out
cp "$BIN" "out/task-$TARGET"
chmod +x "out/task-$TARGET"

# Proof rather than hope: a binary that cannot answer `--version` is not one to
# ship, and "it linked" is not the same claim.
"out/task-$TARGET" --version
file "out/task-$TARGET" | sed 's/^/  /'
echo "built out/task-$TARGET"
