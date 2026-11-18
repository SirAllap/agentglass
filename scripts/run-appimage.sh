#!/bin/sh
# Launch an agentglass AppImage. An AppImage mounts itself through FUSE 2;
# a distro without it fails with a message that does not say what to do.
# This says it, then falls back to running without FUSE.
# Usage: scripts/run-appimage.sh path/to/agentglass.AppImage [args...]
app="${1:?usage: run-appimage.sh path/to/agentglass.AppImage [args...]}"
shift
# libfuse2 lives at one of these, depending on the distro. Any one is enough.
# AGX_FUSE_LIBS (space-separated) replaces the list, so a test can point at a stub.
has_fuse_lib() {
  for f in ${AGX_FUSE_LIBS:-/usr/lib/libfuse.so.2 /usr/lib64/libfuse.so.2 /usr/lib/*/libfuse.so.2 /lib/*/libfuse.so.2}; do
    [ -e "$f" ] && return 0
  done
  return 1
}
if [ "${AGX_FAKE_NO_FUSE:-}" = 1 ] || ! { command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; } \
  || ! has_fuse_lib; then
  echo "agentglass: FUSE 2 is not installed, so the AppImage cannot mount itself." >&2
  echo "agentglass: install libfuse2 (Arch: fuse2, Debian/Ubuntu: libfuse2) to start it directly." >&2
  echo "agentglass: starting it unpacked for now." >&2
  exec "$app" --appimage-extract-and-run "$@"
fi
exec "$app" "$@"
