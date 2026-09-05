// The config agentglass's own tmux server runs with, and the gate that keeps a
// bad one from ever applying.
//
// The pane engine never loads the user's ~/.tmux.conf — it runs `-f` with a
// config of our own (tmuxpane.ts documents the measured reason: the user's
// config loads tpm, which loads tmux-continuum, whose autosave would write our
// chat panes over the user's own resurrect saves). What a user CAN do is edit
// the config for *our server only*, from the settings panel:
//
//   "append"  — generated base conf, then the user's override lines;
//   "replace" — the override lines are the whole config.
//
// Everything goes through validateConf() before it is allowed to exist on
// disk: a broken config must leave the pane engine off with a reason, never
// take the chat down with it. The user's tmux is not involved in validation —
// the check runs on a scratch socket under a scratch TMUX_TMPDIR, so even a
// plugin that fires during the check writes into temp, not into
// ~/.tmux/resurrect.
//
// One more rule, from the panel's standpoint: the agentglass UI owns the tabs
// and the status line. Our server runs `set -g status off` (tmux's own status
// bar is the one thing the UI replaces), and in append mode that line is
// re-asserted after the user's override so a stray `set -g status on` in it
// cannot fight the UI. Replace mode is the user's config and their call.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTmuxBin, tmuxStateDir } from "./tmuxbin.ts";
import { tmuxConfMode, tmuxOverride, writeTmuxSettings, tmuxConfBroken, setTmuxConfBroken, tmuxPrefix, configPath, configDirRedirected } from "./config.ts";

/** The generated base config. Kept here rather than in tmuxpane.ts because the
 *  generation, the validation gate and the override all belong to one seam. */
const BASE = `# Written by agentglass. Do not edit — it is regenerated.
#
# This server must never load the user's tmux.conf. Theirs loads tpm, and
# through it tmux-continuum, whose autosave would write our chat panes over
# their own saved layout in ~/.tmux/resurrect/. Hence \`-f\` on every call.
set -g default-terminal "tmux-256color"
set -g history-limit 20000
# Nothing ever looks at our status line; the chat UI is the status line. Off
# also removes the one place a plugin would have hooked itself in.
set -g status off
set -g mouse on
set -g escape-time 0
# Tabs start at 1, because that is where the number keys are.
#
# tmux counts from 0 and nobody binds a prefix to 0 — every real config on this
# machine's own tmux included flips this, and a strip whose first tab answers to
# a key one place away from where it is drawn is a strip you mis-hit all day.
# Closing a tab DOES renumber, and this was the other way round for a day.
#
# The argument for off was that a window keeping its number is a number you can
# still trust after somebody closes another one, and that off is what this
# machine's own tmux does — it does, by never setting the option. Reported from
# use: close 6 with a 7 beside it and the strip reads 5, 7, which is a gap the
# eye reads as a window that failed to close. The number in a tab is a position
# in a row, not an identity, and a row of tabs with a hole in it is wrong in a
# way a stale number is not.
#
# It also makes the two ways of rearranging agree. Dragging already renumbered —
# that path runs its own move-window -r — so a strip renumbered when you moved
# a tab and did not when you closed one, which is the worse kind of
# inconsistency: it depends on which gesture you happened to use.
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on
# Claude Code asks for this by name and warns in the pane without it.
set -g focus-events on
`;

/**
 * The config file we write. `confPath()` and `writeConf()` are separate because
 * tmuxpane's `tmux()` needs the path on every call while the write only happens
 * when something changed.
 *
 * NAMED AFTER THE SETTINGS IT MATERIALISES, and that is not decoration.
 *
 * This file is generated from config.json, which lives under XDG_CONFIG_HOME —
 * but it was written to the STATE dir, which follows XDG_STATE_HOME. Redirect
 * one and not the other, as every harness in this repo did, and a second
 * instance with different settings silently rewrites the conf the real engine
 * runs on. Then anything that re-sources it — the settings panel's Save, or the
 * prefix heal in tmuxctl — pushes those settings into the live server.
 *
 * Measured on the developer's own machine, twice in one afternoon: a probe with
 * an isolated config (and therefore no prefix set) rewrote `tmux.conf` with
 * `set -g prefix C-b` at 13:30 and again at 14:15, and the desk's engine — which
 * had been on C-f since 08:42 and never restarted — came back reporting C-b.
 * Reported as "tmux has changed on its own again".
 *
 * So a non-default config dir gets a conf of its own. The default path is
 * untouched, which matters: an installed app must not orphan the file its
 * running server was started with.
 */
export function confPath(): string {
  /*
   * AN ISOLATED INSTANCE KEEPS ITS CONF WHERE ITS CONFIG LIVES.
   *
   * The hashed name below was right about the collision and wrong about the
   * place: it wrote `tmux-<hash>.conf` into the SHARED state directory, one per
   * distinct config dir, and a probe or a test run gets a fresh temporary
   * config dir every time. Nothing ever removed them. Measured on the
   * developer's machine: 136 files, 772 KB, none of them referenced by any
   * running tmux, growing since the day the hash was introduced.
   *
   * So when the config dir is redirected and no state dir was named, the conf
   * goes beside that config — and dies with it, which is what a temporary
   * directory is for. The ordinary install is untouched: same path, same file,
   * and an installed app must not orphan the file its running server was
   * started with.
   */
  if (configDirRedirected() && !process.env.AGENTGLASS_STATE_DIR) {
    return join(dirname(configPath()), "tmux.conf");
  }
  return join(tmuxStateDir(), confName());
}

/**
 * Clear out the hashed confs the old placement left behind.
 *
 * Only files matching the shape it wrote, only in our own state directory, and
 * only ones no live tmux was started with — the live check is what makes this
 * safe to run at boot rather than a thing somebody has to remember.
 *
 * Returns how many it removed, for a log line worth reading once.
 */
export function sweepStaleConfs(): number {
  let gone = 0;
  try {
    const dir = tmuxStateDir();
    const live = new Set<string>();
    /* Whatever is running RIGHT NOW, by the `-f` it was started with. A conf in
       use is a conf that must not be removed, however old the file looks. */
    try {
      const ps = Bun.spawnSync(["ps", "-eo", "args"], { stdout: "pipe", stderr: "pipe" });
      for (const m of ps.stdout.toString().matchAll(/-f\s+(\S*tmux-[0-9a-f]{8}\.conf)/g)) live.add(m[1]!);
    } catch { /* no ps: the age check below still holds */ }
    for (const name of readdirSync(dir)) {
      if (!/^tmux-[0-9a-f]{8}\.conf$/.test(name)) continue;
      const full = join(dir, name);
      if (live.has(full)) continue;
      /* An hour, not a day: these belong to a process that either has one open
         or does not, and the only reason to wait at all is a server that is
         mid-start while this runs. */
      try {
        if (Date.now() - statSync(full).mtimeMs < 60 * 60_000) continue;
      } catch { continue; }
      try { rmSync(full, { force: true }); gone++; } catch { /* somebody else's */ }
    }
  } catch { /* no state dir yet */ }
  return gone;
}

/** `tmux.conf` for the ordinary install; `tmux-<8 hex>.conf` when somebody has
 *  redirected XDG_CONFIG_HOME. The hash is over the resolved config dir, so the
 *  same isolated instance keeps its own file across restarts. */
function confName(): string {
  if (!configDirRedirected()) return "tmux.conf";
  return `tmux-${createHash("sha256").update(dirname(configPath())).digest("hex").slice(0, 8)}.conf`;
}

/** Path of the user's override file. Written from the settings panel, read at
 *  generation time — the generated conf is a materialisation of base+override,
 *  never a hand-edited file. */
export function overridePath(): string {
  return join(tmuxStateDir(), "override.conf");
}

/**
 * The prefix, as the three lines tmux wants for it.
 *
 * `set -g prefix` alone leaves C-b still bound, so the old key goes on working
 * and the change reads as half-applied; `send-prefix` is what lets the new key
 * be typed through to a program inside the pane. Three lines nobody should
 * have to remember to move one keystroke — which is why this is a setting and
 * not a paragraph in the override box.
 *
 * Empty means tmux's own default, and the key is validated before it is
 * written (see validTmuxPrefix): it lands in a file the engine executes.
 */
function prefixLines(): string {
  /*
   * Written even when it is the default, and that is the whole point.
   *
   * Choosing "C-b (tmux default)" used to leave the block out — and a saved
   * config is handed to the RUNNING server with `source-file`, which can only
   * add. Re-sourcing a file that no longer mentions the prefix does not undo
   * the `set -g prefix C-a` the previous one applied, so going back to the
   * default was the one direction that really did need a restart. Measured on
   * a live engine: the conf on disk had no prefix at all and the server was
   * still on C-a.
   */
  const key = tmuxPrefix() || "C-b";
  return `# The prefix, from the settings panel.\nunbind C-b\nset -g prefix ${key}\nbind ${key} send-prefix\n`;
}

/** The full config text the engine will run, for the current mode. */
export function confContent(): string {
  const mode = tmuxConfMode();
  const override = tmuxOverride();
  if (mode === "replace") {
    // Replace mode: the override IS the config. An empty one means "no
    // config", which tmux treats as defaults — a plausible choice for somebody
    // who wants a bare server. The status-off footer is enforced structurally
    // either way: the UI owns the bar, no override may hand it back.
    // The prefix goes FIRST here, so a replace-mode config that binds keys of
    // its own has the last word on its own key — the setting is a convenience,
    // not a claim on somebody who has taken the whole config over.
    return `${prefixLines()}${override || "# agentglass: replace mode with an empty override\n"}\n# The UI owns the status line. Enforced in replace mode too.\nset -g status off\n`;
  }
  // Append mode. The status-off line is re-asserted LAST so the override
  // cannot hand the status bar back to tmux — the UI owns it.
  const user = override.trim();
  const body = user ? `\n# --- user override (settings panel) ---\n${user}\n` : "";
  return `${BASE}${prefixLines()}${body}\n# The UI owns the status line. Re-asserted after any override.\nset -g status off\n`;
}

let written: string | null = null;
/** Write the generated conf if the content changed since the last write.
 *  Returns the path. Rewriting on every process start is intentional (a stale
 *  file from an older version is a silent behaviour difference), and so is not
 *  rewriting within a process (the file is ours, nothing else edits it). */
export function ensureConf(): string {
  const content = confContent();
  if (written === content) return confPath();
  const path = confPath();
  /* The conf's OWN directory, not the state directory. Those were the same
     place until an isolated instance started keeping its conf beside its
     config, and this line kept making the other one — so the write threw
     ENOENT and the server never finished starting. Twenty-six route tests
     went red at once, every one of them "a beforeEach hook timed out", which
     is what a server that cannot boot looks like from a test. */
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  written = content;
  return path;
}

/**
 * The longest Unix socket path the check may create. `sun_path` is 108 bytes
 * on Linux and 104 on macOS. The margin is deliberate: the path below is a
 * model of the one tmux builds, and a uid with more digits than the model
 * assumed, or a `T` directory one character longer, must not be the difference
 * between a gate that runs and one that reports every config broken.
 */
export const SOCKET_PATH_BUDGET = 90;

/**
 * Where the throwaway server for one validation lives, and the socket tmux
 * will create in it.
 *
 * tmux puts a `-L name` socket at `$TMUX_TMPDIR/tmux-<uid>/<name>`, and a Unix
 * socket path is bounded by `sun_path` — 104 bytes on macOS. `os.tmpdir()`
 * there is `/var/folders/<2>/<30 random>/T`, 49 bytes before this function has
 * added a word. Measured against that shape with the names this file used to
 * use:
 *
 *     /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/agentglass-conf-check-1757000000000/tmux-501/agx-val-1757000000000
 *
 * is 115 bytes, so `new-session` failed with "File name too long", the gate
 * reported the config broken, and the pane engine never started on a Mac. With
 * the directory name shortened it is exactly 100 — inside the limit by four
 * bytes, and one extra uid digit from failing again. The base itself is the
 * problem, not the names.
 *
 * So the base is `os.tmpdir()` where the whole socket path fits the budget and
 * `/tmp` where it would not. Measured, not decided by platform: a Linux user
 * with a long `TMPDIR` gets the same fallback, and a Mac whose tmpdir happened
 * to be short would keep it. `/tmp` is the one directory tmux itself falls
 * back to (`_PATH_TMP`), so it exists wherever tmux runs.
 *
 * `base` and `uid` are parameters for the suite, which cannot run on a Mac and
 * states that machine's shape instead.
 */
export function validationSandbox(now: number, socket: string, base = tmpdir(), uid = process.getuid?.() ?? 0): { sandbox: string; socketPath: string } {
  const place = (root: string) => {
    const sandbox = join(root, `agx-cc-${now}`);
    return { sandbox, socketPath: join(sandbox, `tmux-${uid}`, socket) };
  };
  const preferred = place(base);
  if (Buffer.byteLength(preferred.socketPath, "utf8") <= SOCKET_PATH_BUDGET) return preferred;
  return place("/tmp");
}

/**
 * Prove a config text is usable before it is ever allowed to exist.
 *
 * Spawns the resolved tmux binary against a scratch socket in a scratch
 * TMUX_TMPDIR with `-f` pointing at the candidate text, creates and kills a
 * session, and reports the stderr on failure. Three properties are being
 * tested at once: the binary runs, the config parses, and (because the whole
 * thing is sandboxed) nothing in the config reaches the user's tmux or their
 * ~/.tmux/resurrect.
 *
 * `now` and `socket` are parameters for the test suite: a test fixes the
 * socket name and the clock instead of racing real temp dirs.
 *
 * What counts as "broken": tmux is surprisingly tolerant of junk in a config
 * — an unknown command, an unknown option or even an unterminated quote
 * prints no stderr and exits 0 (measured on 3.6a), it just silently drops or
 * mangles the line. So the gate does not trust the exit code alone: after the
 * sandbox session is up it probes `show -g status`, which reflects what the
 * config actually applied. `status on` (the default, or a deliberate
 * override) fails the gate — the UI owns the status bar, that is the one
 * invariant a config must not be allowed to break.
 */
export function validateConf(text: string, now = Date.now(), socket = `agx-val-${now}`): { ok: boolean; stderr: string } {
  const bin = resolveTmuxBin();
  if (!bin) return { ok: false, stderr: "tmux is not installed" };
  const { sandbox } = validationSandbox(now, socket);
  try { mkdirSync(sandbox, { recursive: true }); } catch { /* raced */ }
  const conf = join(sandbox, "tmux.conf");
  writeFileSync(conf, text);
  const env = { ...process.env, TMUX_TMPDIR: sandbox };
  try {
    const r = Bun.spawnSync([bin, "-L", socket, "-f", conf, "new-session", "-d"], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return { ok: false, stderr: r.stderr.toString().trim() || `exit ${r.exitCode}` };
    const probe = Bun.spawnSync([bin, "-L", socket, "show", "-g", "status"], { env, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync([bin, "-L", socket, "kill-server"], { env, stdout: "pipe", stderr: "pipe" });
    if (probe.exitCode !== 0) return { ok: false, stderr: probe.stderr.toString().trim() || `exit ${probe.exitCode}` };
    if (probe.stdout.toString().trim() !== "status off") {
      return { ok: false, stderr: "the config leaves tmux's status bar on — it must stay off, the UI owns it" };
    }
    return { ok: true, stderr: "" };
  } catch (e) {
    return { ok: false, stderr: String(e) };
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** Apply a new override (or mode change) from the settings panel.
 *
 *  Validates the would-be generated conf first — a broken override never lands
 *  on disk. On success the file is written and the broken flag cleared; the
 *  new config applies to the next tmux server start (our server reads its
 *  config at server creation, so live panes keep their current one until the
 *  server restarts, which is the safe direction).
 */
export function applyTmuxConf(mode: "append" | "replace", override: string): { ok: boolean; error?: string; appliedAtNextStart: boolean } {
  /*
   * Read what is there BEFORE writing over it.
   *
   * The rollback below called these same readers AFTER the write, so it put
   * back the values it had just saved — a no-op wearing the shape of a revert.
   * A rejected override stayed in config.json, came back in the box on the next
   * open, and was regenerated into the conf at the next start.
   */
  const wasMode = tmuxConfMode();
  const wasOverride = tmuxOverride();
  const write = writeTmuxSettings({ tmuxConfMode: mode, tmuxOverride: override });
  if (!write.ok) return { ok: false, error: write.error, appliedAtNextStart: false };
  const full = confContent();
  const check = validateConf(full);
  if (!check.ok) {
    // Do not leave the bad override on disk: put back what was there, and
    // regenerate so the file on disk and the settings cannot disagree.
    writeTmuxSettings({ tmuxConfMode: wasMode, tmuxOverride: wasOverride });
    ensureConf();
    return { ok: false, error: `config rejected by tmux — ${check.stderr}`, appliedAtNextStart: false };
  }
  setTmuxConfBroken(false);
  ensureConf();
  return { ok: true, appliedAtNextStart: true };
}

/**
 * Is the pane engine allowed to use the generated conf right now?
 *
 * A conf that existed before this process started (a previous run applied it)
 * is validated at boot; a failing one marks the engine degraded with a reason
 * the UI can show — and the settings panel's reset restores everything.
 */
let bootChecked = false;
export function confHealth(): { ok: boolean; reason: string } {
  if (!existsSync(confPath())) return { ok: true, reason: "" };
  /*
   * The file first, the flag second — and once per process, because the check
   * spawns tmux twice.
   *
   * The flag used to short-circuit this, which made it permanent: a mark left
   * by a config that had since been fixed kept the engine off, and the only
   * way out was Reset. Measured on a real machine — the conf on disk passed
   * this very check by hand while the panel read "Pane engine unavailable".
   * A config that is good now is good now; one that is genuinely broken still
   * says so below, with tmux's own words.
   */
  if (!bootChecked) {
    bootChecked = true;
    const check = validateConf(readFileSync(confPath(), "utf8"));
    if (!check.ok) {
      setTmuxConfBroken(true, check.stderr);
      return { ok: false, reason: `tmux config is broken (${check.stderr}) — reset it in the settings panel` };
    }
    // `.broken`, not the object. `tmuxConfBroken()` returns
    // `{ broken, reason }` — always truthy — so this and the line below read
    // "rejected" for every config that had ever been written. That is why the
    // panel said "Pane engine unavailable" on a machine whose config passed the
    // gate by hand, and why the engine's socket never existed.
    if (tmuxConfBroken().broken) setTmuxConfBroken(false);
    return { ok: true, reason: "" };
  }
  if (tmuxConfBroken().broken) return { ok: false, reason: "tmux config was rejected — reset it in the settings panel" };
  return { ok: true, reason: "" };
}

/** Reset everything about our server's config: override cleared, append mode
 *  restored, broken flag cleared, generated conf rewritten, and the tmux
 *  server (ours, and only ours) killed so the next pane starts clean. */
export async function resetTmuxConf(killServer: (name?: string) => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  // The prefix goes back to tmux's own too: "defaults" has to mean defaults, or
  // the button is a partial reset somebody has to guess the shape of.
  const w = writeTmuxSettings({ tmuxConfMode: "append", tmuxOverride: "", tmuxPrefix: "" });
  if (!w.ok) return { ok: false, error: w.error };
  setTmuxConfBroken(false);
  ensureConf();
  try { await killServer(); } catch { /* server already gone */ }
  return { ok: true };
}

/** Test seam: forget the boot check so a suite can exercise the broken path
 *  fresh. */
export function __resetTmuxConfState(): void {
  bootChecked = false;
  written = null;
}
