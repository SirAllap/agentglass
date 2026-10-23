// Processes an agent left behind that are still eating the machine.
//
// Measured, on one machine, in one week: a `bun …/scratchpad/burst.ts` ran two
// days at about 60% of a core with its working directory in a worktree that had
// been deleted, and a `bun test` started from web/ ran six days and fifteen
// hours at about 45%. Both had been re-parented to the user's systemd when the
// shell that started them went away, so nothing in the process tree said whose
// they were and nobody looked. The ports panel cannot see them either: they
// listen on nothing.
//
// Two halves. `classifyOrphans` is pure: parsed rows in, flagged rows with their
// reasons out, so every rule is testable against a table that is written down.
// `sampleOrphans` is the I/O: it reuses the /proc walk in machine.ts (there is
// one walker, not two) and keeps a short ring of CPU ticks per pid, because one
// reading of /proc is a lifetime total and cannot say "sustained".
//
// Cost, stated because the repo counts: one walk every ORPHAN_SAMPLE_MS (5 min)
// is 12 walks an hour. A walk is one readdir of /proc plus a stat and a read of
// /proc/<pid>/stat per process this user owns (about 2N syscalls), and here
// also a readlink of cwd and a read of cmdline per process (2N more). On the
// machine measured, N is a few hundred, so roughly 50,000 syscalls an hour,
// about the cost of two opens of the Resources tab. The panel asks for a fresh
// sample only when it is open, and never faster than ORPHAN_MIN_RESAMPLE_MS.

import { cmdlineOf, cwdOf, ownedByMe, walkProcs } from "./machine.ts";
import type { OrphanProc, OrphanReport, OrphanStopResult } from "../../shared/types.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/** How often the background sampler looks. Slow on purpose: a six-day process
 *  does not need a minute-level answer. */
export const ORPHAN_SAMPLE_MS = 5 * 60_000;
/** The panel's "refresh" may not walk /proc more often than this. */
export const ORPHAN_MIN_RESAMPLE_MS = 30_000;
/** CPU samples kept per pid. Six at five minutes is a half-hour window, long
 *  enough that a compile finishing is not "sustained". */
export const CPU_RING = 6;
/** Seconds the process gets to exit after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 5_000;

export interface OrphanConfig {
  /** Older than this and a flagged process says so as a reason. Seconds. */
  staleAgeSec: number;
  /** A known one-shot command (a test run, a build) still going after this is
   *  stuck or forgotten, whoever its parent is. Seconds. */
  oneShotMaxSec: number;
  /** Percent of one core, averaged over the ring, that counts as eating the
   *  machine. The two measured cases sat at 45 and 60. */
  hotCpu: number;
  /** An average over fewer samples than this is not "sustained". */
  minCpuSamples: number;
}

export const DEFAULT_ORPHAN_CONFIG: OrphanConfig = {
  staleAgeSec: 12 * 3600,
  oneShotMaxSec: 2 * 3600,
  hotCpu: 30,
  minCpuSamples: 3,
};

/** One process as the classifier sees it: the walk's row plus the reads that
 *  are only worth making once per sample. */
export interface OrphanRow {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  /** The raw readlink, so a deleted directory still ends in " (deleted)". */
  cwd: string | null;
  ageSec: number | null;
  /** Average percent of one core over the ring; null before two samples. */
  cpu: number | null;
  cpuSamples: number;
  rss: number;
}

export interface OrphanContext {
  /** Parents that mean "nobody": pid 1 and the user's own `systemd --user`. */
  initPids: number[];
  /** Registered project and worktree roots, to name where a process came from. */
  worktreeRoots?: string[];
  /** This server's own pid: never flagged. */
  selfPid?: number;
  /** The home directory: it is never a worktree, nor is anything above it. */
  home?: string;
  /** Is this directory the root of a git checkout? Injected so the classifier
   *  stays pure in tests; the default looks for a `.git` file or directory. */
  isWorktree?: (dir: string) => boolean;
}

/** Never flagged, whatever else is true. Matched on the executable's basename
 *  (the first word of the command line) and on comm, never on the whole
 *  command line: `bun test` in a checkout called agentglass must not be
 *  exempted by the checkout's name. */
const ALLOWED = [
  // browsers, and the helpers they fork under their own names
  /^(chrome|chromium|google-chrome|brave|firefox|zen|librewolf|vivaldi|msedge|opera)\b/i,
  // this app: the server, the desktop shell, the CLIs
  /^(agentglass|electron)/i,
  // editors
  /^(code|code-oss|cursor|nvim|vim|vi|nano|emacs|hx|helix|zed|micro|kate|gedit|idea|subl)$/i,
  // tmux servers and clients
  /^tmux/i,
  // container runtimes
  /^(dockerd|docker|docker-proxy|containerd|containerd-shim|podman|conmon|runc)/i,
  // init and session plumbing
  /^(systemd|\(sd-pam\)|dbus|dbus-daemon|dbus-broker|pipewire|wireplumber|gpg-agent|ssh-agent)/i,
  // desktop apps and session daemons. Measured on one laptop: 296 of these were
  // flagged because they hang from `systemd --user`, which is where every
  // desktop app hangs.
  /^(slack|signal|discord|spotify|telegram|obsidian|1password|gnome-|gvfs|gsd-|mutter|xdg-|xwayland|fcitx|ibus|voxtype|localsearch|tracker|engram|pipewire|pulseaudio|wireplumber|hyprland|hypr|waybar|walker|mako|swayosd|swaybg|elephant|uwsm|polkit|upowerd|bluetoothd|NetworkManager|nm-|wpa_supplicant|gcr-|at-spi|goa-|evolution|ghostty|kitty|alacritty|foot|git-|gh$|ssh|sshd|tailscale|cupsd|rtkit|dconf|colord|fwupd|udisks|avahi|snapd|flatpak|portal|ollama|syncthing|keyring|secret)/i,
  // shells: an idle shell is the normal state of a terminal
  /^(-?bash|-?zsh|-?fish|-?sh|-?dash|-?nu|-?elvish)$/i,
];

/** Commands that are meant to finish. Matched on the whole command line, and a
 *  watch flag turns a match off: a watcher is supposed to run for hours. */
const ONE_SHOT = [
  /\bbun\s+(run\s+)?test\b/, /\bbun\s+x?\s*vitest\b/, /\bvitest\b(?!.*\bwatch\b)/, /\bjest\b/,
  /\bpytest\b/, /\bcargo\s+(test|build|check)\b/, /\bgo\s+test\b/,
  /\btsc\b/, /\bvite\s+build\b/, /\bnext\s+build\b/, /\bwebpack\b(?!.*--watch)/,
  /\bmake\s+(check|ci|test|smoke)\b/,
  // a script an agent wrote into its scratchpad to measure something
  /\/scratchpad\/[^\s]+\.(ts|js|mjs|py|sh)\b/,
];
const WATCHING = /(^|\s)(--watch|-w|--hot|--watch=true|watch)(\s|$)/;

/** An agent's scratch directory, and the session id that names it. */
const SCRATCH = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/scratchpad(\/|\s|$)/;
const DELETED = / \(deleted\)$/;

/** Executables that live where a package put them are desktop software, not
 *  something an agent wrote. A runtime there (node, python) still runs agent
 *  scripts, so it is judged on its own. */
const SYSTEM_EXE = /^\/(usr\/(lib|libexec|share|lib64|bin)|opt|snap|app|nix|var\/lib\/flatpak|run\/current-system)\//;
const RUNTIME = /^(bun|node|nodejs|deno|python\d*(\.\d+)?|tsc|vite|esbuild|npm|npx|pnpm|yarn|tsx|ts-node)$/;

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function allowed(r: OrphanRow, ctx: OrphanContext): boolean {
  if (r.pid === ctx.selfPid) return true;
  const exe = base(r.cmd.split(/\s+/)[0] ?? "");
  if (ALLOWED.some((re) => re.test(r.comm) || re.test(exe))) return true;
  const path = r.cmd.split(/\s+/)[0] ?? "";
  return SYSTEM_EXE.test(path) && !RUNTIME.test(r.comm) && !RUNTIME.test(exe);
}

/** The checkout a path belongs to, or null. Walks up from the path and stops
 *  BEFORE the home directory, so `~` and everything above it never count, and
 *  a deleted directory still resolves through a registered root. */
function worktreeOf(path: string, ctx: OrphanContext): string | null {
  const home = (ctx.home ?? homedir()).replace(/\/+$/, "");
  const isWt = ctx.isWorktree ?? ((d: string) => existsSync(`${d}/.git`));
  const bad = (d: string) => d === "" || d === "/" || d === home || home.startsWith(`${d}/`);
  const roots = (ctx.worktreeRoots ?? []).filter((w) => !bad(w.replace(/\/+$/, "")));
  let d = path.replace(/\/+$/, "");
  while (!bad(d)) {
    if (roots.includes(d) || isWt(d)) return d;
    d = d.slice(0, d.lastIndexOf("/"));
  }
  return null;
}

/** "2d3h", "45m": how long, for a reason sentence. */
function span(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

/**
 * Flag what looks left behind. A row needs an ORIGIN (a real git checkout that
 * is not the home directory, or an agent scratchpad) AND a symptom:
 *
 *   - sustained CPU past `hotCpu`, while its parent is gone;
 *   - a known one-shot command running past `oneShotMaxSec`;
 *   - its working directory was deleted (also for a language runtime with no
 *     other origin: a `bun` whose checkout is gone is a leftover).
 *
 * Re-parenting alone NEVER flags: every desktop app hangs from `systemd --user`.
 * An unknown command with no origin is never flagged.
 *
 * WHAT IT CANNOT DO: a leftover started from an ordinary directory outside any
 * checkout and doing nothing is not flagged, and a daemon an agent detached on
 * purpose inside a worktree and pegged is, with the reason saying what was seen.
 */
export function classifyOrphans(rows: OrphanRow[], ctx: OrphanContext, cfg: OrphanConfig = DEFAULT_ORPHAN_CONFIG): OrphanProc[] {
  const out: OrphanProc[] = [];
  for (const r of rows) {
    if (allowed(r, ctx)) continue;
    const gone = r.cwd !== null && DELETED.test(r.cwd);
    const cwd = r.cwd === null ? null : r.cwd.replace(DELETED, "");
    const reparented = ctx.initPids.includes(r.ppid);
    const scratch = SCRATCH.exec(`${cwd ?? ""} ${r.cmd}`);
    const paths = [cwd, ...(r.cmd.match(/\/[^\s"']+/g) ?? [])];
    let root: string | null = null;
    for (const p of paths) { if (p && (root = worktreeOf(p, ctx))) break; }
    const origin = scratch ? "an agent scratchpad" : root ? `worktree ${base(root)}` : null;
    const hot = r.cpu !== null && r.cpuSamples >= cfg.minCpuSamples && r.cpu >= cfg.hotCpu;
    const age = r.ageSec;
    const oneShot = ONE_SHOT.some((re) => re.test(r.cmd)) && !WATCHING.test(r.cmd);
    const runtime = RUNTIME.test(r.comm) || RUNTIME.test(base(r.cmd.split(/\s+/)[0] ?? ""));

    const why: string[] = [];
    if (gone && (origin || runtime)) why.push("its working directory was deleted, so the checkout it ran in is gone");
    if (origin && reparented && hot) why.push(`its parent is gone and it averages ${Math.round(r.cpu!)}% of a core`);
    if (origin && oneShot && age !== null && age >= cfg.oneShotMaxSec) {
      why.push(`a command that should finish (${base(r.cmd.split(/\s+/)[0] ?? r.comm)}) has been running for ${span(age)}`);
    }
    if (!why.length) continue;

    if (reparented) why.push(`its parent is gone (it now belongs to ${r.ppid === 1 ? "init" : "your systemd"})`);
    if (origin) why.push(`it came from ${origin}`);
    if (hot && !reparented) why.push(`averaging ${Math.round(r.cpu!)}% of a core`);
    if (age !== null && age >= cfg.staleAgeSec && !why.some((w) => w.includes("running for"))) why.push(`up for ${span(age)}`);

    out.push({
      pid: r.pid, comm: r.comm, cmd: r.cmd, cwd, cwdGone: gone, ageSec: age, cpu: r.cpu, rss: r.rss,
      reasons: why, origin, session: scratch?.[1] ?? null, hot,
    });
  }
  // The ones costing the most first: that is the order they are read in.
  return out.sort((a, b) => Number(b.hot) - Number(a.hot) || (b.cpu ?? 0) - (a.cpu ?? 0) || (b.ageSec ?? 0) - (a.ageSec ?? 0));
}

// ------------------------------------------------------------- sampling ----

const HZ = 100; // USER_HZ, as in machine.ts
type Ring = { start: number; s: { at: number; ticks: number }[] };
const rings = new Map<number, Ring>();
let last: { at: number; report: OrphanReport } | null = null;
let startsOf = new Map<number, number>();

function uptimeSec(): number | null {
  try { const u = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); return Number.isFinite(u) ? u : null; } catch { return null; }
}

/**
 * Walk once, fold the CPU ticks into each pid's ring, classify.
 *
 * `start` guards pid reuse: a recycled number gets a fresh ring instead of
 * inheriting a stranger's ticks.
 */
export function sampleOrphans(ctx: Partial<OrphanContext> = {}, cfg: OrphanConfig = DEFAULT_ORPHAN_CONFIG): OrphanReport {
  const walked = walkProcs();
  const now = Date.now();
  if (!walked) return (last = { at: now, report: { procs: [], at: now, hotCpu: cfg.hotCpu } }).report;
  const up = uptimeSec();
  const rows: OrphanRow[] = [];
  const seen = new Set<number>();
  startsOf = new Map();
  for (const p of walked.rows) {
    const raw = walked.raw.get(p.pid);
    if (!raw) continue;
    seen.add(p.pid);
    startsOf.set(p.pid, raw.start);
    let ring = rings.get(p.pid);
    if (!ring || ring.start !== raw.start) { ring = { start: raw.start, s: [] }; rings.set(p.pid, ring); }
    ring.s.push({ at: walked.at, ticks: raw.ticks });
    if (ring.s.length > CPU_RING) ring.s.shift();
    const a = ring.s[0]!, b = ring.s[ring.s.length - 1]!;
    const cpu = ring.s.length >= 2 && b.at > a.at ? Math.max(0, ((b.ticks - a.ticks) / HZ) / ((b.at - a.at) / 1000) * 100) : null;
    rows.push({
      pid: p.pid, ppid: p.ppid, comm: p.comm, cmd: cmdlineOf(p.pid), cwd: cwdOf(p.pid),
      ageSec: up === null ? null : Math.max(0, Math.round(up - raw.start / HZ)),
      cpu, cpuSamples: ring.s.length, rss: p.rss,
    });
  }
  for (const pid of rings.keys()) if (!seen.has(pid)) rings.delete(pid);

  // The user's own systemd is the parent of everything that detached from a
  // login: it is a process of this user whose parent is init and whose name is
  // systemd, found in the rows rather than assumed.
  const userSystemd = rows.filter((r) => r.comm === "systemd" && r.ppid === 1).map((r) => r.pid);
  const full: OrphanContext = { initPids: [1, ...userSystemd], selfPid: process.pid, ...ctx };
  const report: OrphanReport = { procs: classifyOrphans(rows, full, cfg), at: now, hotCpu: cfg.hotCpu };
  last = { at: now, report };
  return report;
}

/** The report the routes serve: cached, and only recomputed when asked for a
 *  fresh one and the last walk is older than ORPHAN_MIN_RESAMPLE_MS. */
export function orphanReport(fresh: boolean, ctx: Partial<OrphanContext> = {}): OrphanReport {
  if (last && (!fresh || Date.now() - last.at < ORPHAN_MIN_RESAMPLE_MS)) return last.report;
  return sampleOrphans(ctx);
}

/** Start the background sampler. Not called under `bun test`: a suite that left
 *  it running would walk /proc on a schedule nothing in the test asked for. */
export function startOrphanSampler(ctx: () => Partial<OrphanContext> = () => ({})): () => void {
  const tick = () => { try { sampleOrphans(ctx()); } catch { /* the next tick tries again */ } };
  tick();
  const t = setInterval(tick, ORPHAN_SAMPLE_MS);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * Stop ONE process, and only if it is one this sample flags.
 *
 * Sampled fresh before it signals: the button was drawn from a list that may be
 * minutes old, and a pid that has since exited and been reused by something
 * innocent must not take the signal. The start time compared is the one the
 * flagged row was read with. SIGTERM first, SIGKILL after STOP_GRACE_MS if it
 * is still the same process and still there.
 */
export function stopOrphan(pidIn: unknown, ctx: Partial<OrphanContext> = {}, graceMs = STOP_GRACE_MS): OrphanStopResult {
  const pid = Number(pidIn);
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "not a process id" };
  if (pid === process.pid) return { ok: false, error: "that is this server — stop it from the terminal" };
  if (!ownedByMe(pid)) return { ok: false, error: "that process belongs to another user" };
  const report = sampleOrphans(ctx);
  if (!report.procs.some((p) => p.pid === pid)) return { ok: false, error: "that process is not flagged as left behind any more" };
  const start = startsOf.get(pid);
  try { process.kill(pid, "SIGTERM"); } catch { return { ok: false, error: "that process could not be stopped" }; }
  const t = setTimeout(() => {
    // Same process still? The ring's start time says; a reused pid has another.
    const again = walkProcs();
    if (!again || again.raw.get(pid)?.start !== start) return;
    try { process.kill(pid, "SIGKILL"); } catch { /* it went in the meantime */ }
  }, graceMs);
  t.unref?.();
  return { ok: true, detail: `Asked ${pid} to stop` };
}
