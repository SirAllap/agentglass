// Install the agentglass event forwarder into Claude Code's settings from
// inside the app, so someone who installed the binary (README's advised path
// since #186) can turn on live streaming and PreToolUse gating without cloning
// the repo to run a Python script (#187).
//
// This is a faithful TypeScript port of hooks/install_hooks.py's merge, kept
// deliberately in lockstep with it: same nine events, same marker, same
// idempotent "strip our old entries, re-append" so a moved install re-points
// cleanly and nobody else's hooks are touched, same backup-before-write. The
// port exists so the *install* step (writing settings.json) needs no Python —
// the forwarder it wires still runs under python3, which is a separate runtime
// concern the UI names.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HookSetupStatus, HookSetupResult } from "../../shared/types.ts";

// event -> [matcher | null, attach transcript for token/cost]. Mirrors
// install_hooks.py:EVENTS exactly; drift here would let a PR read one way in the
// packaged installer and another from `bun run setup`.
const EVENTS: ReadonlyArray<readonly [string, string | null, boolean]> = [
  ["SessionStart", null, false],
  ["UserPromptSubmit", null, false],
  ["PreToolUse", "*", false],
  ["PostToolUse", "*", false],
  ["Notification", null, false],
  ["SubagentStop", null, true],
  ["Stop", null, true],
  ["PreCompact", null, false],
  ["SessionEnd", null, true],
];

// The substring that identifies a hook command as ours. Same as the Python
// installer's MARKER, so the two agree on what to strip and what "installed"
// means — the app can uninstall hooks `bun run setup` wrote and vice versa.
const MARKER = "send_event.py";
const SL_MARKER = "statusline.sh";

export type { HookSetupStatus, HookSetupResult };

// Resolve the home dir the way Python's expanduser and Claude Code itself do:
// $HOME (or %USERPROFILE% on Windows) wins over the passwd entry. os.homedir()
// alone reads getpwuid and ignores $HOME, so under a custom HOME the sidecar
// would write settings.json where Claude Code will never read it.
function home(): string {
  const env = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return env && env.length ? env : homedir();
}

function settingsPath(): string {
  return join(home(), ".claude", "settings.json");
}

/**
 * The shipped `hooks/` directory, or null if this build does not carry it.
 *
 * Packaged: beside the sidecar binary (extraResources drops `hooks/` into the
 * resources root, next to `agentglass-server`), found via
 * `dirname(process.execPath)` — the same way selfupdate.ts finds build-info.json
 * and self-update.sh. Dev/checkout: the repo's own hooks/, relative to this
 * source file, with cwd as a last resort. Presence is proven by send_event.py,
 * the one file the install actually references.
 */
export function hooksDir(): string | null {
  const candidates = [
    join(dirname(process.execPath), "hooks"),
    resolve(import.meta.dir, "../../hooks"),
    resolve(process.cwd(), "hooks"),
  ];
  for (const d of candidates) {
    if (existsSync(join(d, "send_event.py"))) return d;
  }
  return null;
}

// Interpreter written into the hook command. Mirrors install_hooks.py's
// _hook_python: python3 everywhere but Windows, where python3 is usually absent
// and `py`/`python` is what exists. sys.executable is deliberately not used —
// a venv deleted later would break every hook.
export function hookPython(): string {
  if (process.platform !== "win32") return "python3";
  for (const cand of ["py", "python"]) {
    if (onPath(cand)) return cand;
  }
  return "py";
}

function onPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      if (existsSync(join(d, cmd + ext))) return true;
    }
  }
  return false;
}

function isOurs(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof (h as { command?: unknown })?.command === "string" && (h as { command: string }).command.includes(MARKER));
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/**
 * One event's command line, and the `|| exit 0` that keeps it advisory.
 *
 * Claude Code reads exit code 2 from a PreToolUse hook as "deny this tool
 * call", and python exits 2 when it cannot open the script it was given. So a
 * forwarder that has been moved, renamed or deleted stops being telemetry and
 * becomes a machine-wide block: every tool call, in every session, in every
 * project, including the ones needed to undo it. The path written here is
 * absolute and lives in ~/.claude/settings.json, which outlives this clone.
 *
 * Telemetry must never be able to gate tool execution. send_event.py already
 * exits 0 on every path it controls; this covers the one it does not.
 *
 * Kept identical to `hook_command` in hooks/install_hooks.py — the two write
 * the same file and a settings.json is not allowed to depend on which one did.
 */
export function hookCommand(python: string, sendEvent: string, event: string, addChat: boolean, windows = process.platform === "win32"): string {
  // Quote the script path unconditionally: a clone under a spaced path breaks
  // the hook command on every platform, not only Windows.
  let cmd = `${python} "${sendEvent}" --event-type ${event}`;
  if (addChat) cmd += " --add-chat";
  return cmd + (windows ? " || exit /b 0" : " || exit 0");
}

// Append our forwarder to each event after stripping any prior agentglass entry
// (so a moved install re-points cleanly). Every other hook is preserved.
function doInstall(cfg: any, sendEvent: string, python: string, statusline?: string): void {
  const hooks = (cfg.hooks ??= {});
  for (const [event, matcher, addChat] of EVENTS) {
    const arr = asArray(hooks[event]).filter((e) => !isOurs(e));
    const cmd = hookCommand(python, sendEvent, event, addChat);
    const entry: any = { hooks: [{ type: "command", command: cmd }] };
    if (matcher !== null) entry.matcher = matcher;
    arr.push(entry);
    hooks[event] = arr;
  }
  if (statusline) installStatusLine(cfg, statusline);
}

/**
 * The status line slot, taking whatever was in it along for the ride.
 *
 * `statusLine` is one slot rather than a list, so there is no adding to it
 * without owning it. Owning it is only acceptable because the previous command
 * is run on every render with the same stdin and owns the output — see
 * hooks/statusline.sh, where every path out still runs the chain. It travels as
 * a quoted argument so it stays visible in the settings.json the user reads,
 * and so uninstall can restore it without consulting any state of ours.
 *
 * Not installed on Windows: the forwarder is POSIX sh, and a status line that
 * fails is one the user sees on every single render. The usage poll still works
 * there, just without the free feed.
 */
function installStatusLine(cfg: any, statusline: string): void {
  if (process.platform === "win32") return;
  const cur = cfg.statusLine;
  const curCmd = cur && typeof cur === "object" && typeof cur.command === "string" ? cur.command : null;
  // Already ours: re-point the script path, keep what it wraps.
  const chained = curCmd && curCmd.includes(SL_MARKER) ? chainedFrom(curCmd) : curCmd;
  cfg.statusLine = { type: "command", command: statusLineCommand(statusline, chained) };
}

function statusLineCommand(statusline: string, chained: string | null): string {
  return chained ? `sh "${statusline}" ${shQuote(chained)}` : `sh "${statusline}"`;
}

/** Single-quote for `sh`, the way Python's shlex.quote does — the two
 *  installers write the same string or they cannot undo each other. */
function shQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) && s !== "" ? s : `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** What our wrapper was told to call. Mirrors shlex.split closely enough for
 *  the shape we write: `sh "<path>" '<chained>'`. */
function chainedFrom(cmd: string): string | null {
  if (!cmd.includes(SL_MARKER)) return null;
  const m = cmd.match(/^sh\s+"[^"]*"\s+(.+)$/);
  if (!m) return null;
  const rest = m[1]!.trim();
  if (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) {
    return rest.slice(1, -1).replace(/'"'"'/g, "'");
  }
  return rest;
}

function uninstallStatusLine(cfg: any): void {
  const cur = cfg.statusLine;
  const curCmd = cur && typeof cur === "object" && typeof cur.command === "string" ? cur.command : null;
  if (!curCmd || !curCmd.includes(SL_MARKER)) return;
  const chained = chainedFrom(curCmd);
  if (chained) cfg.statusLine = { type: "command", command: chained };
  else delete cfg.statusLine;
}

// Drop only our entries; leave everyone else's hooks untouched, and remove a
// now-empty event / an empty hooks object so uninstall is a clean reversal.
function doUninstall(cfg: any): void {
  const hooks = cfg.hooks;
  if (!hooks || typeof hooks !== "object") return;
  for (const event of Object.keys(hooks)) {
    const kept = asArray(hooks[event]).filter((e) => !isOurs(e));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  uninstallStatusLine(cfg);
}

// Sorted-key stringify for change detection, matching the Python installer's
// json.dumps(sort_keys=True): a rewrite happens only on a real change, never
// because two runs serialised the same object in a different key order. Array
// order is preserved (our entries are always appended last, so re-running is a
// no-op).
function stable(v: any): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]));
    }
    return val;
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readCfg(path: string): { cfg: any } | { error: string } {
  if (!existsSync(path)) return { cfg: {} };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (e: any) {
    return { error: `could not read ${path}: ${String(e?.message ?? e)}` };
  }
  if (!raw) return { cfg: {} };
  try {
    return { cfg: JSON.parse(raw) };
  } catch {
    // Same stance as the Python installer: never touch a settings.json we
    // cannot parse. Overwriting it would eat hooks we do not understand.
    return { error: `${path} is not valid JSON; leaving it untouched. Fix it and try again.` };
  }
}

/*
 * THE GATE, WHICH IS A DIFFERENT BARGAIN AND SO A DIFFERENT SWITCH.
 *
 * The forwarder above is telemetry, and the rule beside it is that telemetry
 * must never be able to stop a tool call — its command ends `|| exit 0` for
 * exactly that reason. The gate is the opposite by design: it HOLDS a tool
 * call until a person decides, and an outward one (a push, a comment, a
 * review, a ticket, a message in a channel) is held closed.
 *
 * That is why it installs and uninstalls on its own, and why nothing here
 * turns it on as a side effect of anything else. The orchestrator running a
 * real project on this machine named the gap in one sentence when asked what
 * it was missing: "hoy eso lo sostiene la memoria y la cortesía de los
 * agentes; funcionó, pero por cultura, no por herramienta." The tool existed
 * and there was no switch.
 *
 * One PreToolUse entry, matcher `*`, and NO `|| exit 0`: swallowing the exit
 * status is what makes telemetry advisory, and a gate whose refusal is
 * swallowed is not a gate. `gate_event.py` allows on every failure it controls
 * — an unreachable server, a timeout, a bad answer — so the honest failure
 * mode is already inside the script rather than bolted on outside it.
 */
const GATE_MARKER = "gate_event.py";
const isGate = (e: any): boolean => asArray(e?.hooks).some((h: any) => String(h?.command ?? "").includes(GATE_MARKER));

export function gateCommand(python: string, script: string): string {
  return `${python} "${script}"`;
}

export function installGate(cfg: any, script: string, python: string): void {
  const hooks = cfg.hooks ?? (cfg.hooks = {});
  /* Any earlier entry of ours goes first, so re-installing from a moved build
     re-points the path instead of leaving two. */
  const arr = asArray(hooks.PreToolUse).filter((e) => !isGate(e));
  arr.push({ matcher: "*", hooks: [{ type: "command", command: gateCommand(python, script) }] });
  hooks.PreToolUse = arr;
}

export function uninstallGate(cfg: any): void {
  const hooks = cfg?.hooks;
  if (!hooks) return;
  const kept = asArray(hooks.PreToolUse).filter((e) => !isGate(e));
  if (kept.length) hooks.PreToolUse = kept;
  else delete hooks.PreToolUse;
  if (hooks && Object.keys(hooks).length === 0) delete cfg.hooks;
}

/** Whether the gate hook is wired right now. */
export function gateInstalled(): boolean {
  const r = readCfg(settingsPath());
  if (!("cfg" in r)) return false;
  return asArray((r.cfg?.hooks ?? {}).PreToolUse).some(isGate);
}

/**
 * Turn the gate on or off, writing the same backup the other install writes.
 *
 * Deliberately the same shape as `applyHooks` rather than a flag on it: two
 * switches, two answers, and no way to get the gate by asking for telemetry.
 */
export function applyGate(action: "install" | "uninstall"): HookSetupResult {
  const path = settingsPath();
  const dir = hooksDir();
  if (action === "install" && (!dir || !existsSync(join(dir, GATE_MARKER)))) {
    return { ok: false, installed: false, changed: false, settingsPath: path, error: "the gate hook is not bundled with this build" };
  }
  const r = readCfg(path);
  if ("error" in r) return { ok: false, installed: false, changed: false, settingsPath: path, error: r.error };
  const cfg = r.cfg;
  const before = stable(cfg);
  if (action === "install") installGate(cfg, join(dir!, GATE_MARKER), hookPython());
  else uninstallGate(cfg);
  const installed = action === "install";
  if (stable(cfg) === before) return { ok: true, installed, changed: false, settingsPath: path };

  let backup: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      backup = `${path}.bak.agentglass.${stamp()}`;
      copyFileSync(path, backup);
    }
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e: any) {
    return { ok: false, installed: false, changed: false, settingsPath: path, error: String(e?.message ?? e) };
  }
  return { ok: true, installed, changed: true, backup, settingsPath: path };
}

export function hookStatus(): HookSetupStatus {
  const path = settingsPath();
  const r = readCfg(path);
  let installed = false;
  if ("cfg" in r) {
    const hooks = (r.cfg?.hooks ?? {}) as Record<string, unknown>;
    installed = Object.values(hooks).some((arr) => asArray(arr).some(isOurs));
  }
  const dir = hooksDir();
  return {
    installed, bundled: dir !== null, settingsPath: path, python: hookPython(),
    gate: "cfg" in r && asArray(((r.cfg?.hooks ?? {}) as any).PreToolUse).some(isGate),
    gateBundled: dir !== null && existsSync(join(dir, GATE_MARKER)),
  };
}

export function applyHooks(action: "install" | "uninstall"): HookSetupResult {
  const path = settingsPath();
  const dir = hooksDir();
  if (action === "install" && !dir) {
    return { ok: false, installed: false, changed: false, settingsPath: path, error: "the hook scripts are not bundled with this build" };
  }

  const r = readCfg(path);
  if ("error" in r) return { ok: false, installed: false, changed: false, settingsPath: path, error: r.error };
  const cfg = r.cfg;

  const before = stable(cfg);
  if (action === "install") doInstall(cfg, join(dir!, "send_event.py"), hookPython(), join(dir!, "statusline.sh"));
  else doUninstall(cfg);
  const changed = stable(cfg) !== before;

  const installed = action === "install";
  if (!changed) return { ok: true, installed, changed: false, settingsPath: path };

  let backup: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      backup = `${path}.bak.agentglass.${stamp()}`;
      copyFileSync(path, backup);
    }
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e: any) {
    return { ok: false, installed: false, changed: false, settingsPath: path, error: String(e?.message ?? e) };
  }
  return { ok: true, installed, changed: true, backup, settingsPath: path };
}

// Exported for the test that pins parity with the Python installer's merge.
export const _internal = {
  doInstall, doUninstall, isOurs, stable, EVENTS, MARKER,
  installGate, uninstallGate, isGate, gateCommand, GATE_MARKER,
  installStatusLine, uninstallStatusLine, statusLineCommand, chainedFrom, shQuote, SL_MARKER,
};
