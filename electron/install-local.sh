#!/usr/bin/env bash
# Build and install the desktop app for the current user (no root).
#
# Packages an unpacked Electron app (electron-builder --dir, which needs no
# AppImage tooling) with a fresh web build and the compiled server sidecar
# baked in, then installs it under ~/.local — the desktop spec picks it up.
set -euo pipefail

# Everything below is the Linux install: electron-builder's `linux-unpacked`,
# ~/.local/share, a .desktop file, symlinks into ~/.local/bin. There is no macOS
# half, and on a Mac the script used to spend the packaging minutes first and
# then stop at `[ -x "$SRC/agentglass" ]` with a line about electron-builder
# not producing the binary — the wrong diagnosis for a build that was fine and
# a layout that was another OS's. Say so before doing anything, and say what a
# Mac does instead: the .dmg, per architecture, named as the release job names
# it (see .github/workflows/desktop-binaries.yml).
case "$(uname -s)" in
  Darwin)
    cat >&2 <<'MSG'
install-local.sh installs the Linux layout (~/.local/share + a .desktop file) and has no macOS half.
On a Mac, install from the .dmg on the latest release: https://github.com/SirAllap/agentglass/releases/latest
  Apple silicon: agentglass_<version>_arm64.dmg      Intel: agentglass_<version>_x64.dmg
To build one from this checkout instead: (cd electron && node build.mjs && bunx electron-builder --mac dmg)
MSG
    exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/.local/share/agentglass-desktop"
BIN="$HOME/.local/bin"
DESKTOP="$HOME/.local/share/applications"

# electron-builder is invoked here rather than through `bun run dist:dir` for
# one reason: the output directory has to be overridable. dist-app is shared,
# several sessions build out of this worktree at once, and verifying a change to
# this script must not mean packaging on top of somebody else's half-written
# package — or worse, reading a stamp out of it.
DIST="${AGENTGLASS_DIST_DIR:-$HERE/dist-app}"
echo "==> packaging (fresh web build + sidecar, unpacked) into $DIST"
( cd "$HERE" && node build.mjs && bunx electron-builder --dir -c.directories.output="$DIST" )

SRC="$DIST/linux-unpacked"
[ -x "$SRC/agentglass" ] || { echo "electron-builder did not produce $SRC/agentglass" >&2; exit 1; }

# What is actually in this package, read out of the package.
#
# Not out of build.mjs's stdout: this script has printed success for work it had
# not done before, and the stamp is the field that answers "does my installed
# app have the security fix?". Reading it from the artefact is the only version
# of that answer worth having.
#
# And it is printed BEFORE anything is stopped or replaced, itemised, because
# the failure this closes is a build that silently carried another session's
# uncommitted electron/main.js onto the desktop. Nothing here refuses: this is a
# shared worktree with several agents in it and it is dirty most of the day, so
# a rule that stopped the install would be worse than the bug. It just makes it
# impossible to install uncommitted work without seeing that you did.
#
# Parsed with node rather than sed: the file is JSON, node is already a hard
# dependency two lines below, and a regexp that reads a value out of JSON is one
# odd string away from confidently reporting the wrong stamp — which is the bug
# this whole change is about.
STAMP_FILE="$SRC/resources/build-info.json"
read_stamp() {
  node -e '
    const fs = require("node:fs");
    let j = {};
    // node -e swallows the "--", so the file is argv[1] and the mode argv[2].
    try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { /* reported as unknown */ }
    if (process.argv[2] === "id") {
      process.stdout.write(String(j.stamp || (j.commit ? String(j.commit).slice(0, 7) : "") || "unknown"));
    } else if (j.dirty) {
      console.log("    it is NOT a commit — these packaged files differ from HEAD:");
      for (const f of j.dirtyFiles ?? []) console.log("      " + f);
    }
  ' -- "$STAMP_FILE" "$1"
}
STAMP="$(read_stamp id)"
echo "==> this package is $STAMP"
read_stamp files >&2

# The tree can move between build.mjs stamping it and electron-builder copying
# the files — a window of a minute or so on a worktree three sessions are
# editing. Re-hashing here closes it, and it is free: nothing has been stopped
# yet, so the cost of refusing is one rebuild rather than an outage.
( cd "$HERE" && node build.mjs --check-stamp "$STAMP_FILE" )

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

# THE DEPUTY IS MID-RUN? THEN NOT NOW.
#
# The check itself lives in appctl.sh, next to the other things this script
# asks about the machine, because it is driven by tests: the version that lived
# here counted with a `grep -o` pipeline, and grep's "matched nothing" exit
# aborted the install under `set -e` whenever no run was going — the refusal
# fired when it was safe and stayed quiet when it did.
#
# shellcheck source=appctl.sh
. "$HERE/appctl.sh"
refuse_if_deputy_busy || exit 1

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
if ! stop_app; then
  echo "refusing to install over a running app: $(app_pids | tr '\n' ' ')survived SIGKILL" >&2
  exit 1
fi

# From here on the app is DOWN because this script took it down, and everything
# below can fail: `set -e`, a failed verify, a full disk. It used to just exit,
# and the person was left with no app, no window, and no line saying that was
# why — which is precisely what happened today after a verification failure.
#
# A trap rather than a check at each exit, because `set -e` makes "just exit"
# the default behaviour of anything that goes wrong down here, and the paths
# nobody thought of are the ones that stranded him. PHASE is how far it got; see
# restore_after_failed_install in appctl.sh for what each value is allowed to
# promise.
PHASE=stopped
RESTORED=0
trap 'code=$?; if [ "$code" -ne 0 ] && [ "$RESTORED" -eq 0 ]; then RESTORED=1; restore_after_failed_install "$code" "$PHASE"; fi' EXIT

mkdir -p "$APP" "$BIN" "$DESKTOP"

PHASE=replacing
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
PHASE=replaced
ln -sf "$APP/agentglass" "$BIN/agentglass"

# Did the copy actually land?
#
# It did not, once, and nothing said so: the app was reinstalled three times in
# an afternoon and went on serving a renderer bundle from two commits earlier,
# while this script printed "installed:" every time. That is the worst kind of
# failure — the person looking at the app concludes the WORK is wrong, and goes
# looking for a bug that is not there.
#
# The copy above cannot be trusted to report for itself: `cp -r "$SRC/."` is
# expected to fail on chrome-sandbox, so its exit code is discarded, and with
# it every other failure it might have had. So the check is on the result, not
# on the exit code — the one artifact that changes with every web build is the
# hashed bundle name in index.html, which is exactly what a stale renderer
# shows.
verify_installed() {
  local what="$1" src="$2" dst="$3"
  if [ ! -f "$src" ]; then echo "refusing: $what missing from the package ($src)" >&2; return 1; fi
  if [ ! -f "$dst" ]; then echo "refusing: $what did not reach the install ($dst)" >&2; return 1; fi
  if ! cmp -s "$src" "$dst"; then
    echo "refusing: $what differs between the package and the install" >&2
    echo "  packaged: $src" >&2
    echo "  installed: $dst" >&2
    return 1
  fi
}

fail=0
verify_installed "the renderer (index.html)" \
  "$SRC/resources/web/index.html" "$APP/resources/web/index.html" || fail=1
verify_installed "the build stamp" \
  "$SRC/resources/build-info.json" "$APP/resources/build-info.json" || fail=1
# The bundle index.html names, not merely index.html itself: a matching html
# that points at a file which never arrived is the same stale renderer.
bundle="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$APP/resources/web/index.html" | head -1 || true)"
if [ -n "$bundle" ] && [ ! -f "$APP/resources/web/$bundle" ]; then
  echo "refusing: the installed page asks for $bundle, which is not there" >&2
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  # No claim here about what survived: the copy above has already run. The EXIT
  # trap says which of the two situations this is, and reopens what was stopped.
  exit 1
fi
echo "==> verified: the installed renderer is the one just built ($bundle)"

# The agent-facing CLI, out of the INSTALLED app rather than the checkout it was
# built from.
#
# It was the checkout, and that was a time bomb: this gets built from a
# throwaway worktree as often as not, so the symlink pointed at a directory that
# exists until the branch lands and then does not. `command -v` goes on saying
# yes and every call an agent makes fails. The app directory is the one path
# here that is stable, so the CLI ships inside it (extraResources) and this
# points at that.
if [ -f "$APP/resources/bin/agentglass-browser" ]; then
  chmod +x "$APP/resources/bin/agentglass-browser" 2>/dev/null || true
  ln -sf "$APP/resources/bin/agentglass-browser" "$BIN/agentglass-browser"
  # The same browser as an MCP server, for clients that would rather have tools
  # with schemas than a command whose output they must parse back.
  if [ -f "$APP/resources/bin/agentglass-browser-mcp" ]; then
    chmod +x "$APP/resources/bin/agentglass-browser-mcp" 2>/dev/null || true
    ln -sf "$APP/resources/bin/agentglass-browser-mcp" "$BIN/agentglass-browser-mcp"
  fi
fi
# The named-agent CLI: a script's launcher and liveness for unattended agents
# on the engine. Same home as the browser CLI, for the same reason.
if [ -f "$APP/resources/bin/agentglass-agent" ]; then
  chmod +x "$APP/resources/bin/agentglass-agent" 2>/dev/null || true
  ln -sf "$APP/resources/bin/agentglass-agent" "$BIN/agentglass-agent"
fi

# The skill that tells an agent the CLI exists.
#
# Shipping it in the app is not enough and that was the bug: a skill nothing has
# copied into ~/.claude/skills is a file no agent will ever read, so the feature
# was complete and unreachable at the same time. Installed here, where the CLI
# it documents is installed, because the two are useless apart.
#
# Copied rather than symlinked: this outlives any particular build, and a
# dangling skill is a tool an agent believes in and cannot use.
if [ -f "$APP/resources/skills/browser-use/SKILL.md" ]; then
  mkdir -p "$HOME/.claude/skills/browser-use"
  cp "$APP/resources/skills/browser-use/SKILL.md" "$HOME/.claude/skills/browser-use/SKILL.md"
fi

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
echo "  stamp    $STAMP"
echo "  command  agentglass"
[ -L "$BIN/agentglass-browser" ] && echo "  agent cli agentglass-browser (drives the built-in browser)"
[ -L "$BIN/agentglass-browser-mcp" ] && echo "  mcp      claude mcp add agentglass-browser -- agentglass-browser-mcp"
[ -f "$HOME/.claude/skills/browser-use/SKILL.md" ] && echo "  skill    ~/.claude/skills/browser-use (so agents know it is there)"
echo "  launcher $DESKTOP/agentglass.desktop"

# Put back what we took down. An install has to close the running app — it is
# replacing the files underneath it — and leaving it closed made the normal
# loop (merge, `make desktop-update`, look at the change) end with the window
# gone and no sign that reopening it was the next step. Nothing happens here if
# nothing was running.
#
# RESTORED first, so a failure to reopen does not reopen twice: `set -e` turns
# a non-zero start_app into an exit, and the EXIT trap would otherwise try the
# same thing again.
RESTORED=1
start_app
