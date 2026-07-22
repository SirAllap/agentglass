#!/usr/bin/env bash
# Build and install the desktop app for the current user (no root).
#
# Packages an unpacked Electron app (electron-builder --dir, which needs no
# AppImage tooling) with a fresh web build and the compiled server sidecar
# baked in, then installs it under ~/.local — the desktop spec picks it up.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/.local/share/agentglass-desktop"
BIN="$HOME/.local/bin"
DESKTOP="$HOME/.local/share/applications"

echo "==> packaging (fresh web build + sidecar, unpacked)"
( cd "$HERE" && bun run dist:dir )

SRC="$HERE/dist-app/linux-unpacked"
[ -x "$SRC/agentglass" ] || { echo "electron-builder did not produce $SRC/agentglass" >&2; exit 1; }

# Refuse to install something that is not an executable.
#
# `bun build --compile` can write a file that is the right size, exits 0, and is
# not an ELF binary at all — writing the outfile onto tmpfs produced exactly
# that. Installed, it left the app with a server that started and immediately
# vanished, no error anywhere: the UI came up and every request failed. Checking
# the artifact is one line and turns that into a build that stops.
for exe in "$SRC/agentglass" "$SRC/resources/agentglass-server"; do
  [ -f "$exe" ] || { echo "missing $exe" >&2; exit 1; }
  case "$(file -b "$exe")" in
    ELF*executable*|ELF*shared\ object*|Mach-O*) ;;
    *) echo "refusing to install: $exe is not an executable ($(file -b "$exe" | cut -c1-40))" >&2; exit 1 ;;
  esac
done

# A running instance holds these files open, and `rm -rf` under it leaves the
# app alive on deleted inodes — it keeps running the old code and its sidecar
# keeps :4000, so the next launch adopts a stale server. Stop it first.
#
# Signal the MAIN process, and only it. `pkill -f "$APP/agentglass"` also
# matches every Electron child — gpu-process, the zygotes, the renderer — and
# tearing those out while the main process is running its own quit path
# (stopSidecar, then app.quit) wedges it: the window freezes for a long time,
# and sometimes it never exits at all. That is how a rebuild ends up copying
# over an app that is still running. Asked properly it goes down in under two
# seconds — eight processes, 0.2s, measured against the real tree.
#
# Which pid is which comes from /proc/<pid>/exe rather than from the shape of
# the command line, because every cmdline pattern precise enough to exclude the
# helpers also excludes a main process that was started with an argument, and
# `agentglass --ozone-platform=wayland` or `--no-sandbox` is an ordinary way to
# start this app. A stop step that silently matches nothing is the original bug
# with extra steps: the script would sail past it into rm -rf. See appctl.sh.
# shellcheck source=appctl.sh
. "$HERE/appctl.sh"
if ! stop_app; then
  echo "refusing to install over a running app: $(app_pids | tr '\n' ' ')survived SIGKILL" >&2
  exit 1
fi

mkdir -p "$APP" "$BIN" "$DESKTOP"
# Everything except chrome-sandbox, which must stay root-owned and setuid.
# Replacing it drops those bits and Electron then refuses to start on any
# distro that restricts unprivileged user namespaces (Ubuntu 24.04+), which
# needs a sudo round trip to undo.
if [ -u "$APP/chrome-sandbox" ] 2>/dev/null; then
  find "$APP" -mindepth 1 -maxdepth 1 ! -name chrome-sandbox -exec rm -rf {} +
  cp -r "$SRC/." "$APP/" 2>/dev/null || true
  # cp will have failed on chrome-sandbox alone; the rest is in place.
else
  rm -rf "$APP"
  cp -r "$SRC" "$APP"
fi
ln -sf "$APP/agentglass" "$BIN/agentglass"

# Chromium won't run unsandboxed: it wants chrome-sandbox owned by root with
# the setuid bit, and the namespace sandbox it would otherwise fall back to is
# disabled on Ubuntu 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1).
# So this is not optional there — without it the app aborts at launch instead
# of opening a window. A fresh install lays the helper down with our uid, so it
# has to be granted then.
#
# A reinstall does not: the copy above deliberately steps around an existing
# setuid helper rather than replacing it, so a machine that has been through
# this once needs no root again. Hence the first test — asking for a password
# that is not needed, or warning about a bit that is already set, trains people
# to ignore both.
#
# Never fatal, and kept out of `set -e`'s reach by living in `if` conditions:
# leaving a half-installed app with no launcher would be worse than one that
# needs a single manual command.
sandbox_ok=false
if [ -u "$APP/chrome-sandbox" ] && [ "$(stat -c %U "$APP/chrome-sandbox" 2>/dev/null)" = root ]; then
  sandbox_ok=true
elif sudo -n true 2>/dev/null || [ -t 0 ]; then
  if sudo chown root:root "$APP/chrome-sandbox" && sudo chmod 4755 "$APP/chrome-sandbox"; then
    sandbox_ok=true
  fi
fi
if [ "$sandbox_ok" = false ]; then
  echo "warn: chrome-sandbox needs root, or the app will abort at launch. Run:" >&2
  echo "  sudo chown root:root $APP/chrome-sandbox && sudo chmod 4755 $APP/chrome-sandbox" >&2
fi

install -m644 "$HERE/icons/icon-512.png" "$APP/icon.png" 2>/dev/null || true
cat > "$DESKTOP/agentglass.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=agentglass
Comment=Real-time cockpit for your Claude Code agents
Exec=$APP/agentglass
Icon=$APP/icon.png
Terminal=false
Categories=Development;
EOF
chmod 644 "$DESKTOP/agentglass.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP" 2>/dev/null || true

echo "installed:"
echo "  app      $APP/agentglass"
echo "  command  agentglass"
echo "  launcher $DESKTOP/agentglass.desktop"

# Put back what we took down. An install has to close the running app — it is
# replacing the files underneath it — and leaving it closed made the normal
# loop (merge, `make desktop-update`, look at the change) end with the window
# gone and no sign that reopening it was the next step. Nothing happens here if
# nothing was running.
start_app
