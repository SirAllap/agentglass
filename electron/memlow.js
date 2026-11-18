// @ts-check
// Keep the app's own memory out of the reclaimer's reach.
//
// Measured: the terminal froze for 1-13 s while the rest of the app kept
// working. server-stall.log showed `server stall ms=13156 last=tmux
// show-options` followed by `mem-pressure some=0.65 full=0.65`. The machine
// had vm.swappiness=150 and ~10 GB in swap during docker test suites and bun
// test runs; the server (a child of this process, in the same systemd user
// scope `app.slice/app-agentglass-electron-<pid>.scope`) had ~145 MB of its own
// pages swapped out, and the terminal goes through the server's websocket, so
// a request that touched a paged-out page waited on the disk. The scope had
// memory.low=0, which protects nothing. Server + renderer RSS was ~1.3 GB, so
// MemoryLow defaults to 1536M: the kernel reclaims from every other cgroup
// first. memory.low is soft (never an OOM, never a cap), so an oversize guess
// costs nothing but the protection.
//
// One property on the scope covers Electron and the server, because the server
// is spawned as a plain child and inherits the cgroup.
//
// The read happens too early at app.whenReady: the process is still in its
// launcher's scope (`app-Hyprland-gtk\x2dlaunch-N.scope`, or a terminal pane's
// `tmux-spawn-<uuid>.scope`) and Chromium moves itself into its own
// `app-agentglass-electron-<pid>.scope` over D-Bus a moment later. The first
// version set MemoryLow on the launcher's scope and left the app's at 0, and
// success was silent. So only a unit ending in `-<pid>.scope` is accepted, and
// startup retries a bounded number of times (RETRY_MS apart, TRIES at most)
// until it appears. That is a bounded startup retry, not a periodic poll.
//
// Pure decision here (which unit, which command) so a test can assert it; the
// side effect is one execFile, logged once on failure, never awaited by startup.

"use strict";

const DEFAULT_LOW = "1536M";

const RETRY_MS = 2000;
const TRIES = 10;

/** A systemd memory size: bytes, or K/M/G/T suffix. */
const SIZE = /^\d+[KMGT]?$/i;

/**
 * Whether a unit is this app's own, and not the one that launched it.
 *
 * The pid alone was the rule (`<...>-<pid>.scope`), and it had two holes.
 * A launcher that execs the app keeps the pid, so its scope
 * (`app-Hyprland-gtk\x2dlaunch-<pid>.scope`) ended in the app's pid too and
 * was accepted: MemoryLow on the launcher's scope, the app's own left at 0,
 * which is the mistake the pid rule was written to end. And the app started
 * as a systemd user service has no scope at all, so it got nothing and
 * logged "own scope never appeared" after ten tries. So: a scope must carry
 * the pid AND name the app (Chromium names its scope after the app:
 * `app-agentglass-electron-<pid>.scope`), and a service that names the app is
 * accepted as it is. Ceiling: a build whose desktop name holds neither
 * "agentglass" nor "electron" gets no reserve, and says so in the log.
 *
 * @param {string} unit last element of the cgroup path
 * @param {number} pid process.pid
 */
function ownUnit(unit, pid) {
  if (unit.endsWith(".service")) return /agentglass/i.test(unit);
  return unit.endsWith(`-${pid}.scope`) && /agentglass|electron/i.test(unit);
}

/**
 * @param {string} cgroupText contents of /proc/self/cgroup
 * @param {string} platform process.platform
 * @param {string | undefined} override AGENTGLASS_MEMORY_LOW: a size, or 0/off to skip
 * @param {number} pid process.pid: only `<...>-<pid>.scope` is this app's own scope
 * @returns {{ unit: string, args: string[] } | null} null = do nothing
 */
function memoryLowCommand(cgroupText, platform, override, pid) {
  if (platform !== "linux") return null;
  const want = (override ?? "").trim();
  if (/^(off|none|false)$/i.test(want) || want === "0") return null;
  if (want && !SIZE.test(want)) return null;
  // cgroup v2 is one line `0::/path`; v1 lines have a controller list and no
  // unit systemd --user can set properties on.
  const line = cgroupText.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const parts = line.slice(3).split("/").filter(Boolean);
  const unit = parts[parts.length - 1] ?? "";
  if (!ownUnit(unit, pid)) return null;
  // Only a user manager's unit: user.slice/user-N.slice/user@N.service/...
  if (!parts.some((p) => /^user@\d+\.service$/.test(p))) return null;
  return { unit, args: ["--user", "set-property", "--runtime", unit, `MemoryLow=${want || DEFAULT_LOW}`] };
}

/** @param {(msg: string) => void} log */
function protectMemory(log) {
  const fs = require("fs");
  const { execFile } = require("child_process");
  let tries = 0;
  const attempt = () => {
    try {
      const text = fs.readFileSync("/proc/self/cgroup", "utf8");
      const cmd = memoryLowCommand(text, process.platform, process.env.AGENTGLASS_MEMORY_LOW, process.pid);
      if (!cmd) {
        // null also means "off" or "not linux": only retry when a user manager owns us.
        if (process.platform !== "linux" || !/user@\d+\.service/.test(text)) return;
        const off = (process.env.AGENTGLASS_MEMORY_LOW ?? "").trim();
        if (/^(off|none|false)$/i.test(off) || off === "0" || (off && !SIZE.test(off))) return;
        if (++tries >= TRIES) {
          const seen = (text.split("\n").find((l) => l.startsWith("0::")) ?? "").split("/").pop();
          log(`memory.low: own scope or service never appeared (${seen})`);
          return;
        }
        setTimeout(attempt, RETRY_MS);
        return;
      }
      execFile("systemctl", cmd.args, { timeout: 5000 }, (/** @type {Error | null} */ err) => {
        if (err) log(`memory.low not set on ${cmd.unit}: ${String(err.message).split("\n")[0]}`);
        else log(`memory.low=${cmd.args[cmd.args.length - 1].slice("MemoryLow=".length)} set on ${cmd.unit}`);
      });
    } catch (e) {
      log(`memory.low skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  attempt();
}

/*
 * The same reserve, written down so it outlives a reboot.
 *
 * `set-property --runtime` above lands in /run and dies with the session, and
 * it can only run once Chromium has moved itself into its own scope: up to
 * TRIES * RETRY_MS after start, the app runs unprotected. A user drop-in is
 * read by systemd when the scope is created, every launch, every boot. The
 * scope's name carries the pid (`app-agentglass-electron-<pid>.scope`), so the
 * drop-in uses systemd's dash-prefix rule: `app-agentglass-electron-.scope.d/`
 * applies to every unit whose name starts with that prefix. Written by
 * install-local.sh into the person's own ~/.config: no root.
 */
const DROPIN_DIR = "app-agentglass-electron-.scope.d";
const DROPIN_FILE = "50-agentglass-memory-low.conf";

/**
 * @param {string | undefined} override AGENTGLASS_MEMORY_LOW at install time
 * @returns {string | null} the drop-in text, or null = remove it (off, or a size systemd would not take)
 */
function dropInText(override) {
  const want = (override ?? "").trim();
  if (/^(off|none|false)$/i.test(want) || want === "0") return null;
  if (want && !SIZE.test(want)) return null;
  return [
    "# Written by agentglass's install (electron/install-local.sh).",
    "# Soft reserve: the kernel reclaims from other programs first. Never a cap.",
    "# Remove: AGENTGLASS_MEMORY_LOW=off make desktop-install, or delete this file.",
    "[Scope]",
    `MemoryLow=${want || DEFAULT_LOW}`,
    "",
  ].join("\n");
}

/**
 * Write or remove the drop-in under a systemd user config dir.
 * @param {string} configHome $XDG_CONFIG_HOME or ~/.config
 * @param {string | undefined} override
 * @returns {string} one line for the install log
 */
function installDropIn(configHome, override) {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(configHome, "systemd", "user", DROPIN_DIR);
  const file = path.join(dir, DROPIN_FILE);
  const text = dropInText(override);
  if (text === null) {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
    return `memory.low drop-in removed (${file})`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o644 });
  return `memory.low drop-in ${file}`;
}

module.exports = { memoryLowCommand, ownUnit, protectMemory, dropInText, installDropIn, DEFAULT_LOW, DROPIN_DIR, DROPIN_FILE };

// install-local.sh: `node memlow.js --install-dropin`
if (require.main === module && process.argv[2] === "--install-dropin") {
  if (process.platform === "linux") {
    const home = process.env.XDG_CONFIG_HOME || require("path").join(require("os").homedir(), ".config");
    console.log(installDropIn(home, process.env.AGENTGLASS_MEMORY_LOW));
  }
}
