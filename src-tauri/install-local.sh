#!/usr/bin/env bash
# Install the desktop app for the current user only — no root, no packaging.
#
# Linux: everything lands under ~/.local, which is already on the standard
# search paths, so the launcher picks it up without touching system dirs.
# macOS: the .app bundle goes to ~/Applications, with CLI entry points
# symlinked under ~/.local so `agentglass` and `make desktop-open` work.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/agentglass"

if [ "$(uname)" = Darwin ]; then
  APP_SRC="$REPO/src-tauri/target/release/bundle/macos/agentglass.app"
  [ -d "$APP_SRC" ] || { echo "missing $APP_SRC — run 'make desktop' first" >&2; exit 1; }
  [ -x "$APP_SRC/Contents/MacOS/agentglass-server" ] || {
    echo "no server sidecar inside $APP_SRC — run 'make desktop' first" >&2; exit 1; }

  mkdir -p "$HOME/Applications" "$BIN_DIR" "$APP_DIR"
  rm -rf "$HOME/Applications/agentglass.app"
  ditto "$APP_SRC" "$HOME/Applications/agentglass.app"

  BIN="$HOME/Applications/agentglass.app/Contents/MacOS/agentglass"
  ln -sf "$BIN" "$BIN_DIR/agentglass"
  ln -sf "$BIN" "$APP_DIR/agentglass"

  echo "installed:"
  echo "  app      ~/Applications/agentglass.app"
  echo "  command  agentglass"
  echo
  echo "Find it in Spotlight as 'agentglass'. To start it at login, use the"
  echo "autostart toggle in the app rather than editing files by hand."
  exit 0
fi

BIN_SRC="$REPO/src-tauri/target/release/agentglass"
SIDECAR="$(find "$REPO/src-tauri/bin" -name 'agentglass-server-*-linux-*' -type f 2>/dev/null | head -n1)"
[ -n "$SIDECAR" ] || { echo "no Linux server sidecar in src-tauri/bin — run 'make desktop' first" >&2; exit 1; }

DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"

[ -x "$BIN_SRC" ] || { echo "missing $BIN_SRC — run 'make desktop' first" >&2; exit 1; }
[ -x "$SIDECAR" ] || { echo "missing $SIDECAR — run 'make desktop' first" >&2; exit 1; }

mkdir -p "$BIN_DIR" "$APP_DIR/bin" "$DESKTOP_DIR"

# The app and its server live together: Tauri resolves a sidecar relative to
# the executable. The target-triple suffix only exists so the build can tell
# platforms apart — it is dropped on the way out, so install it under the plain
# name or the app won't find it.
install -m755 "$BIN_SRC" "$APP_DIR/agentglass"
install -m755 "$SIDECAR" "$APP_DIR/agentglass-server"
ln -sf "$APP_DIR/agentglass" "$BIN_DIR/agentglass"

for size in 32 64 128; do
  src="$REPO/src-tauri/icons/${size}x${size}.png"
  [ -f "$src" ] || continue
  mkdir -p "$ICON_DIR/${size}x${size}/apps"
  install -m644 "$src" "$ICON_DIR/${size}x${size}/apps/agentglass.png"
done

sed "s|%%EXEC%%|$APP_DIR/agentglass|" "$REPO/src-tauri/agentglass.desktop" \
  > "$DESKTOP_DIR/agentglass.desktop"
chmod 644 "$DESKTOP_DIR/agentglass.desktop"

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
command -v gtk-update-icon-cache   >/dev/null && gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null || true

echo "installed:"
echo "  app      $APP_DIR/agentglass"
echo "  launcher $DESKTOP_DIR/agentglass.desktop"
echo "  command  agentglass"
echo
echo "Search your launcher for 'agentglass'. To start it at login, use the"
echo "autostart toggle in the app rather than editing files by hand."
