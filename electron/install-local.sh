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
