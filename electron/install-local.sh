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

mkdir -p "$APP" "$BIN" "$DESKTOP"
rm -rf "$APP"
cp -r "$SRC" "$APP"
ln -sf "$APP/agentglass" "$BIN/agentglass"

# Chromium won't run unsandboxed: it wants chrome-sandbox owned by root with
# the setuid bit, and the namespace sandbox it would otherwise fall back to is
# disabled on Ubuntu 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1).
# So this is not optional there — without it the app aborts at launch instead
# of opening a window. The cp above gives the helper our uid and starts from a
# clean dir, so it has to be re-applied on every install.
#
# Never fatal, and kept out of `set -e`'s reach by living in `if` conditions:
# leaving a half-installed app with no launcher would be worse than one that
# needs a single manual command.
sandbox_ok=false
if sudo -n true 2>/dev/null || [ -t 0 ]; then
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
