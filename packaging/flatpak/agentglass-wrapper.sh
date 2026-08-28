#!/bin/sh
# What has to be true before the app starts, inside a Flatpak.
#
# Four things, and none of them are the app's business to know: where scratch
# files go, how to reach the host's tools, which shell is actually the user's,
# and where to leave a hook script that the HOST will run later.
set -eu

# Flatpak's own convention. Electron writes a lot here and $TMPDIR otherwise
# points at a /tmp shared with every other instance of this runtime.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
mkdir -p "$TMPDIR"

# The shims from packaging/flatpak/hostbin.ts. First on PATH, so `Bun.which`
# finds the host's git rather than concluding there isn't one.
export PATH="/app/hostbin:${PATH}"

# Flatpak overwrites $SHELL with /bin/sh, so the user's real login shell has to
# be asked for over the portal. Measured, not assumed: inside the sandbox $SHELL
# reads /bin/sh even for a user whose shell is fish.
#
# This matters twice. The terminal opens $SHELL, and the bundled tmux takes its
# default-shell from the same variable -- left alone, both would open a sandbox
# shell with no agent CLIs in it, which looks like the app is broken rather than
# like it is confined.
#
# `|| true` because a failed lookup must degrade to a working /bin/sh, not to a
# launcher that exits under `set -e` before the app ever starts.
host_shell="$(flatpak-spawn --host getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7 || true)"
export AGENTGLASS_HOST_SHELL="${host_shell:-/bin/sh}"
export SHELL=/app/hostbin/hostshell

# The hook forwarder has to live somewhere the host can reach.
#
# hooksetup.ts writes an ABSOLUTE path to send_event.py into the host's
# ~/.claude/settings.json, and the host's Claude Code is what runs it. A path
# under /app is real for the sidecar and imaginary for everybody else, so the
# forwarder is staged into this app's data directory -- inside the home
# directory, so it means the same thing on both sides of the sandbox.
#
# `cp -a src/.` overwrites in place rather than replacing the directory: it is
# safe to run twice, and it never leaves a window where a hook firing mid-launch
# finds nothing there. Non-fatal throughout -- a copy that fails should cost
# live session streaming, not the app.
hooks_src=/app/agentglass/resources/hooks
hooks_dst="${XDG_DATA_HOME:-$HOME/.local/share}/agentglass/hooks"
if [ -d "$hooks_src" ]; then
  if mkdir -p "$hooks_dst" && cp -a "$hooks_src/." "$hooks_dst/"; then
    export AGENTGLASS_HOOKS_DIR="$hooks_dst"
  else
    echo "agentglass: could not stage hooks to $hooks_dst; live session streaming will be off" >&2
  fi
fi

# zypak lets Electron's own sandbox work inside Flatpak's. --ozone-platform-hint
# picks Wayland where there is one and falls back to X11 through the socket
# granted in the manifest.
exec zypak-wrapper /app/agentglass/agentglass --ozone-platform-hint=auto "$@"
