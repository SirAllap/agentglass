#!/usr/bin/env bash
# An isolated agentglass desktop instance for agx-bench: its own port, its own
# config, data, cache, state, database and tmux, all under one directory, so a
# benchmark run never reads or writes the instance somebody is working in.
#
#   scripts/agx-bench/instance.sh start  [DIR] [PORT]   # boots it, waits for the browser panel
#   scripts/agx-bench/instance.sh status [DIR]
#   scripts/agx-bench/instance.sh stop   [DIR]          # stops only what start started
#
# DIR defaults to /tmp/agx-bench and PORT to 4831. DIR must stay short: tmux
# refuses a socket path longer than ~107 bytes, and the socket lives under it.
#
# The window. Electron has no working headless mode here (`--ozone-platform=
# headless` crashes Electron 43), and the browser guest only paints inside a
# real window. On Hyprland the window goes, silently and without focus, to a
# workspace of the real monitor that nobody works on (5, or
# AGX_BENCH_WORKSPACE), and `start` refuses while that workspace is on screen.
# No virtual output: a headless one shows up to the person as a second screen
# and breaks their screenshots, so none is ever created. Hyprland's exec rules match the window by
# PID, so the command it runs is this script's `_exec`, which `exec`s the real
# Electron binary — the node wrapper in node_modules/.bin would start the
# window from a child PID and the rules would be ignored without a word.
# Anywhere else the window simply opens (set AGX_BENCH_NO_WINDOW_RULES=1 to
# force that path on Hyprland too).
#
# D-Bus. The instance gets no session bus at all (`disabled:`). A private bus
# (dbus-run-session) is worse, not better, for a Chromium: it D-Bus-activates
# a second copy of the desktop portal on that bus, which crashes when the bus
# closes and raises a crash notification on the desktop.
#
# Stopping is by recorded PID and by the PID holding this instance's own port,
# never by a process-name pattern: a pattern also matches every other copy of
# the same binary on the machine.
set -euo pipefail

CMD=${1:-status}
DIR=${2:-${AGX_BENCH_DIR:-/tmp/agx-bench}}
PORT=${3:-${AGX_BENCH_PORT:-4831}}
# Absolute from here on. Processes are recognised by a file they hold open
# under DIR, and /proc prints those links absolute: a relative DIR matched
# nothing, so `stop` left Electron and the sidecar running on the port. DIR is
# also pasted into the compositor's command line inside a quoted string, so a
# character that would end or escape that string is refused.
case "$DIR" in *[[:space:]\"\\]*) echo "DIR must not contain whitespace, quotes or backslashes: '$DIR'" >&2; exit 2;; esac
DIR=$(realpath -m -- "$DIR")
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WS=${AGX_BENCH_WORKSPACE:-5}
[[ "$WS" =~ ^[0-9]+$ ]] || { echo "AGX_BENCH_WORKSPACE must be a workspace number, got '$WS'" >&2; exit 2; }

port_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
# A recorded PID is only acted on while it is still this instance's process:
# a pid file outlives its process, and the number can be reused by anything.
# The mark is a file open under DIR (the sidecar holds the database, Electron
# its profile). Not the environment: Chromium rewrites its own environ block
# when it sets the process title, and AGENTGLASS_DB is gone from it.
ours() { alive "${1:-}" && ls -l "/proc/$1/fd" 2>/dev/null | grep -F -- "-> $DIR/" >/dev/null; }
hypr() { [ -z "${AGX_BENCH_NO_WINDOW_RULES:-}" ] && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && command -v hyprctl >/dev/null; }

electron_bin() {
  if [ -n "${AGX_BENCH_ELECTRON:-}" ]; then echo "$AGX_BENCH_ELECTRON"; return; fi
  local b
  b=$(readlink -f "$REPO/electron/node_modules/electron/dist/electron" 2>/dev/null || true)
  [ -x "$b" ] || { echo "no electron binary under electron/node_modules — run bun install, or set AGX_BENCH_ELECTRON" >&2; exit 1; }
  echo "$b"
}

case "$CMD" in
_exec)
  # Runs as the window's own process (see above). Everything it needs was
  # written by `start`, because a compositor-launched command inherits the
  # compositor's environment, not the shell's.
  # shellcheck disable=SC1091
  . "$DIR/launch.env"
  echo $$ > "$DIR/electron.pid"
  cd "$REPO/electron"
  exec "$ELECTRON" "$REPO/electron" --no-sandbox >> "$DIR/electron.log" 2>&1
  ;;

start)
  [ -f "$REPO/web/dist/index.html" ] || { echo "web/dist is missing — run: (cd web && bun run build)" >&2; exit 1; }
  if ours "$(cat "$DIR/electron.pid" 2>/dev/null || true)"; then echo "already running: $DIR"; exit 0; fi
  if [ -n "$(port_pid "$PORT")" ]; then echo "port $PORT is taken by something else" >&2; exit 1; fi
  mkdir -p "$DIR"/{cfg,data,cache,xdg-state,state,tmux,browser}
  ELECTRON=$(electron_bin)
  BUN_DIR=$(dirname "$(command -v bun)")
  {
    printf 'export PATH=%q\n' "$BUN_DIR:/usr/local/bin:/usr/bin:/bin"
    printf 'export HOME=%q\n' "$HOME"
    printf 'export ELECTRON=%q\n' "$ELECTRON"
    for v in WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE DISPLAY XAUTHORITY; do
      [ -n "${!v:-}" ] && printf 'export %s=%q\n' "$v" "${!v}"
    done
    printf 'unset TMUX TMUX_PANE AGENTGLASS_TOKEN AGENTGLASS_BIND AGENTGLASS_WEB_DIR AGENTGLASS_DIE_WITH_PARENT AGENTGLASS_TRUST_LAN AGENTGLASS_ROOT AGENTGLASS_PTY_SIZE_FILE AGENTGLASS_DEBUG_PORT AGENTGLASS_SERVER\n'
    printf 'export DBUS_SESSION_BUS_ADDRESS=disabled:\n'
    printf 'export XDG_CONFIG_HOME=%q XDG_DATA_HOME=%q XDG_CACHE_HOME=%q XDG_STATE_HOME=%q\n' \
      "$DIR/cfg" "$DIR/data" "$DIR/cache" "$DIR/xdg-state"
    printf 'export AGENTGLASS_STATE_DIR=%q AGENTGLASS_DB=%q TMUX_TMPDIR=%q AGENTGLASS_PORT=%q\n' \
      "$DIR/state" "$DIR/agentglass.db" "$DIR/tmux" "$PORT"
    # No transcript scan: it imports every agent session under the real HOME
    # into this instance's database (431 MB in half an hour, measured, and the
    # /tmp quota full), and the bench reads none of it.
    printf 'export AGENTGLASS_SCAN_DISABLED=1\n'
    printf 'export SHELL=/bin/bash\n'
  } > "$DIR/launch.env"
  echo "$PORT" > "$DIR/port"
  : > "$DIR/electron.log"
  rm -f "$DIR/electron.pid"

  if hypr; then
    # Never onto a workspace somebody is looking at.
    if hyprctl monitors -j | python3 -c "import json,sys; sys.exit(0 if any(m['activeWorkspace']['id']==$WS for m in json.load(sys.stdin)) else 1)"; then
      echo "workspace $WS is on screen right now; not starting a window there" >&2
      exit 1
    fi
    hyprctl eval "hl.exec_cmd(\"$HERE/instance.sh _exec $DIR\", { workspace = \"$WS silent\", float = true, size = \"1440 900\", no_initial_focus = true })" >/dev/null
  else
    setsid "$HERE/instance.sh" _exec "$DIR" </dev/null >/dev/null 2>&1 &
  fi

  for _ in $(seq 1 100); do [ -s "$DIR/electron.pid" ] && break; sleep 0.1; done
  PID=$(cat "$DIR/electron.pid" 2>/dev/null || true)
  alive "$PID" || { echo "electron did not start; see $DIR/electron.log" >&2; exit 1; }

  if hypr; then
    # Where did the window land? Anywhere but its workspace is a window on
    # somebody's screen: stop at once rather than run the benchmark there.
    for _ in $(seq 1 100); do
      AT=$(hyprctl clients -j | python3 -c "import json,sys; print(next((str(c['workspace']['id']) for c in json.load(sys.stdin) if c['pid']==$PID), ''))")
      [ -n "$AT" ] && break; sleep 0.2
    done
    if [ "${AT:-}" != "$WS" ]; then
      echo "the window landed on workspace '${AT:-none}', not $WS — stopping it" >&2
      "$HERE/instance.sh" stop "$DIR" >&2 || true
      exit 1
    fi
  fi

  # Ready means a window has registered its browser panel with the server.
  TOKEN_FILE="$DIR/cfg/agentglass/token"
  for _ in $(seq 1 300); do
    if [ -s "$TOKEN_FILE" ]; then
      W=$(curl -s -m 2 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "http://127.0.0.1:$PORT/browser-use/status" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('windows',0))" 2>/dev/null || echo 0)
      [ "${W:-0}" -gt 0 ] && { echo "ready: http://127.0.0.1:$PORT  pid $PID  dir $DIR"; exit 0; }
    fi
    alive "$PID" || { echo "electron exited; see $DIR/electron.log" >&2; exit 1; }
    sleep 0.2
  done
  echo "no browser window registered within 60 s; see $DIR/electron.log" >&2
  exit 1
  ;;

status)
  PID=$(cat "$DIR/electron.pid" 2>/dev/null || true)
  if ours "$PID"; then echo "running: pid $PID port $(cat "$DIR/port") dir $DIR"; else echo "stopped: $DIR"; exit 1; fi
  ;;

stop)
  PID=$(cat "$DIR/electron.pid" 2>/dev/null || true)
  P=$(cat "$DIR/port" 2>/dev/null || echo "$PORT")
  if ours "$PID"; then
    kill "$PID"
    for _ in $(seq 1 50); do alive "$PID" || break; sleep 0.1; done
    if ours "$PID"; then kill -9 "$PID"; sleep 0.5; fi
    if alive "$PID"; then echo "pid $PID did not stop; leaving everything else in place" >&2; exit 1; fi
  elif alive "$PID"; then
    echo "pid $PID in $DIR/electron.pid is not this instance's process; not touching it" >&2
  fi
  # The sidecar dies with its parent. If it did not, the process on this
  # instance's port is stopped only when it holds this instance's files.
  for _ in $(seq 1 30); do [ -z "$(port_pid "$P")" ] && break; sleep 0.1; done
  SIDE=$(port_pid "$P")
  if ours "$SIDE"; then kill "$SIDE"; fi
  # The app's own tmux engine, if it started one: only sockets inside this
  # instance's own TMUX_TMPDIR, addressed by path, so no other server can be
  # the one that answers.
  for sock in "$DIR"/tmux/tmux-*/*; do
    [ -S "$sock" ] || continue
    env -u TMUX tmux -S "$sock" kill-server 2>/dev/null || true
  done
  rm -f "$DIR/electron.pid"
  echo "stopped: $DIR"
  ;;

*)
  echo "usage: $0 start|status|stop [DIR] [PORT]" >&2
  exit 2
  ;;
esac
