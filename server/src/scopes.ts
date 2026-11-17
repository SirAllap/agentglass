/*
 * Each child this app starts gets its own transient systemd scope, so one
 * runaway costs that child and not every agent's app state.
 *
 * Measured on one machine on 2026-11-04: systemd-oomd killed
 * `app-agentglass-electron-1156150.scope` — 1085 processes, 11.8 GB RSS and
 * 10 GB swap — at 29.9/32.7 GB. Seventeen of those app scopes were still
 * there, sixteen with a dead leader and live children: an `opencode` 26 h old,
 * 18 chromium 57 h, git 25 h. Nothing reaped them, and because every child
 * lived in the app's one cgroup, oomd could only choose between the whole app
 * and nothing.
 *
 * Three halves here, and each fails closed:
 *
 *   * `scopeArgv` wraps a launch in `systemd-run --user --scope` with a
 *     `MemoryMax` and no swap, so a runaway child is the one oomd is offered.
 *     A machine without `systemd-run`, or `AGENTGLASS_SCOPES=0`, gets the
 *     plain argv: nothing about a launch depends on this.
 *   * `ensureWorkerSlice` puts every one of those scopes in ONE slice and gives
 *     the slice a `MemoryMax` and a `MemoryHigh`. A per-scope ceiling bounds
 *     each runaway and not their sum: on the same 31.3 GiB machine three
 *     workers at a third of RAM each could ask 30G while the app itself peaked
 *     at 9.3G, and the box OOM-killed the app and tmux. The slice is named
 *     inside `app.slice` on purpose: systemd-oomd only considers descendants
 *     of the cgroup it watches, and a sibling slice leaves the app and tmux as
 *     its only candidates. The per-scope wall stays as the second one — one
 *     worker may still burst — and a machine that cannot have the slice keeps
 *     exactly the argv it had before.
 *   * `stopOwnScopes` runs when this process exits, for the scopes it started;
 *     `reapStaleScopes` stops one whose owner is gone — an
 *     `app-agentglass-electron-*` whose leader died, or an `agentglass-child-*`
 *     whose server (the pid in its name) did — once its youngest process,
 *     anywhere in it, is older than the age setting. Both go through
 *     `systemctl --user stop <unit>`. There is no `pkill` here, and no match on
 *     a command line: a unit name is an identity, a pattern is not. A scope
 *     holding a tmux anywhere in it — its own cgroup or one nested below — is
 *     kept, and so is one whose comms could not be read: unknown is not empty,
 *     and the cost of waiting is another sweep.
 *   * `adoptOrphanScopes` runs once, at boot, and skips the age question: a
 *     child scope whose server pid is dead is a leftover unless a process in it
 *     names a worker whose turn is still in flight — or is a serve, or works in
 *     a live row's directory — and that one is adopted, so a restart does not
 *     kill the private server of a worker that is working. `endWindowScopes`
 *     stops the scope of a run when the window that run belonged to goes; a
 *     turn ending only stops the serve (the wrapper's job).
 *   * `memoryWatch` is mem-watch's top-RSS-per-scope read, in the cockpit: the
 *     rows are computed only above 80 % memory pressure, which is when the
 *     question "what is in there" is being asked.
 *
 * tmux is deliberately outside all of it: its panes are never scoped, never
 * named here and never stopped, because an agent session outlives the app
 * (tmuxrestore.ts).
 */
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { scopeConfig, envLimit } from "./config.ts";
import { OWNER_VAR } from "./reaper.ts";
import { setIntervalAs, spawnSyncAs } from "./loopwatch.ts";

/** The prefix of the transient unit each child gets. */
export const SCOPE_PREFIX = "agentglass-child-";
/** The unit systemd makes for the desktop app itself; the stale reaper's target. */
export const APP_SCOPE_PREFIX = "app-agentglass-electron-";
/** Every scope this module may list for memory: ours, and the app's own. */
export const MEMORY_SCOPE_PREFIXES = [APP_SCOPE_PREFIX, SCOPE_PREFIX] as const;
/**
 * The default ceiling is a share of this machine's RAM, not a size.
 *
 * Measured on one machine on 2026-11-04, 31.3 GiB of RAM: 18 kernel memcg OOM
 * kills that day, in 16 distinct `agentglass-child-*` scopes, each scope given
 * `memory.max` 3221225472 (3 GiB) with `MemorySwapMax=0`. The tasks killed were
 * 15 qemu VMs from a `bun test`, two `opencode serve`s and a node tool; the
 * biggest was a qemu at 2.79 GiB anon-rss, so one `bun test` filled the ceiling
 * by itself. And a scope holds more than one thing: the serve AND every tool it
 * spawns — a turn has held a 2.8 GB serve, a 2.9 GB bun test and a 1.9 GB java
 * tool at once, 7.6 GB — and the kill reached the worker as its engine's socket
 * dying (ECONNRESET), not as a memory message.
 *
 * A third of RAM is 10G on that machine, 2.4 GB over the worst turn measured,
 * and leaves two thirds for the app, the seat's own engine and the desktop. The
 * floor keeps a machine of 12 GiB or more above one bun test plus one serve
 * (5.7 GB measured); the cap is past anything a turn has needed, where one
 * child stops being a runaway and becomes the machine; and no scope is given
 * more than half the box, so a small laptop's scope is still the cgroup that
 * kills rather than a ceiling the kernel has to enforce over everything.
 * Overrides are unchanged: `AGENTGLASS_SCOPE_MEMORY_MAX`, then `scopeMemoryMax`
 * in the file.
 */
export const MEMORY_MAX_SHARE = 1 / 3;
export const MEMORY_MAX_FLOOR = 6 * 2 ** 30;
export const MEMORY_MAX_CAP = 24 * 2 ** 30;
export const DEFAULT_MAX_AGE_H = 6;
/** Above this share of RAM the per-scope RSS rows are worth computing. */
export const MEMORY_PRESSURE = 0.8;
/** How often the stale-scope sweep runs. A six-hour scope does not need a minute. */
export const SWEEP_EVERY_MS = 10 * 60_000;

/**
 * The one slice every child scope joins, and the share of RAM its wall keeps
 * back for the app and the desktop.
 *
 * The name is load-bearing. systemd makes `a-b.slice` a subslice of `a.slice`,
 * and systemd-oomd only considers DESCENDANTS of the cgroup it watches — on a
 * user manager `/user.slice/user-1000.slice/user@1000.service/app.slice`,
 * measured with `oomctl` on 2026-11-05. A slice outside that subtree (the
 * first version of this was `agentglass-workers.slice`, a sibling of
 * `app.slice`) leaves the app's own scopes and the tmux panes as the only
 * candidates oomd has, which is the opposite of the point.
 *
 * The reserve is a third of RAM — the app's own peak plus room to work: 9.3G
 * of a 31.3 GiB machine measured on 2026-11-05, when three workers at 10G each
 * asked 30G and the box OOM-killed the app and tmux. It is never less than 4G
 * (on an 8G laptop a third is less than one engine server and a desktop
 * session), never more than half the machine, and otherwise follows what
 * `app.slice` already holds plus 1G: that subtree measured 11.75-12.16 GiB on
 * a 30.45 GiB box, more than the 10.45G a third reserves, and a wall reached
 * only after the box is over-committed is not a wall. The half-RAM cap wins
 * over the app's own size, which is the deliberate rule. `MemoryHigh` sits
 * just under the wall in whole GiB — a tenth from 16G up, a quarter at 8G —
 * because throttling is cheaper than a kill.
 */
export const WORKER_SLICE = "app-agentglass-workers.slice";
/** The name this slice had before it moved under `app.slice`: a sibling that
 *  systemd-oomd does not watch, left loaded by an upgrade. */
export const LEGACY_WORKER_SLICE = "agentglass-workers.slice";
export const SLICE_RESERVE_SHARE = 1 / 3;
export const SLICE_RESERVE_MIN = 4 * 2 ** 30;
export const SLICE_APP_HEADROOM = 1 * 2 ** 30;
export const SLICE_HIGH_SHARE = 0.9;

export interface ScopeSettings {
  on: boolean;
  /** A systemd size (`3G`, `512M`). Anything else is refused for the default.
   *  The per-scope wall: the second one, under the slice's. */
  memoryMax: string;
  /** The slice every child scope joins, so their sum has a wall of its own. */
  slice: string;
  /** The slice's walls, which bound every child together. */
  sliceMemoryMax: string;
  sliceMemoryHigh: string;
  /** True when a configured slice was larger than this machine allows and was
   *  clamped to it (`ensureWorkerSlice` says so once). */
  sliceClamped?: boolean;
  maxAgeMs: number;
}

const SIZE = /^[1-9]\d{0,6}[KMGT]?$/;

/** A size systemd will take, or null: a typo must not become a ceiling nobody has. */
export function validSize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return SIZE.test(s) ? s : null;
}

const SIZE_UNITS: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

/** A size in bytes; 0 for anything `validSize` would refuse. */
function sizeBytes(size: string): number {
  const s = size.trim().toUpperCase();
  if (!SIZE.test(s)) return 0;
  const unit = SIZE_UNITS[s.slice(-1)];
  return unit ? Number(s.slice(0, -1)) * unit : Number(s);
}

/** Whole GiB at or below `bytes`, as systemd takes it, and never zero. */
function wholeGiB(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / 2 ** 30))}G`;
}

export interface ScopeConfig {
  off?: boolean;
  memoryMax?: string;
  sliceMemoryMax?: string;
  maxAgeHours?: number;
}

/** One `kB` field of `/proc/meminfo`, in bytes; 0 when it is not there. */
function meminfoBytes(meminfo: string, field: string): number {
  const m = meminfo.match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"));
  return m ? Number(m[1]) * 1024 : 0;
}

/** This machine's `MemTotal`, or 0 when `/proc/meminfo` says nothing. */
export function memTotal(meminfo: string): number {
  return meminfoBytes(meminfo, "MemTotal");
}

/** The ceiling a child's scope gets by default: `MEMORY_MAX_SHARE` of this
 *  machine's RAM, clamped, as the largest whole GiB at or below it. */
export function defaultMemoryMax(meminfo: string): string {
  const total = memTotal(meminfo);
  const share = Math.min(MEMORY_MAX_CAP, Math.max(MEMORY_MAX_FLOOR, total * MEMORY_MAX_SHARE));
  /* Never above half the machine: a ceiling larger than the box hands the kill
     to the kernel's global OOM killer, which is what the scope exists to
     avoid. */
  const bytes = total > 0 ? Math.min(share, total / 2) : share;
  return wholeGiB(bytes);
}

/**
 * The wall every child together gets: this machine's RAM less a reserve for the
 * app and the desktop, as whole GiB. 8G→4G, 16G→10G, 31.3G→20G, 64G→42G.
 *
 * `appBytes` is what `app.slice` already holds (`appSliceBytes`), and it raises
 * the reserve when a third of RAM is less than that. On a machine of 8 GiB or
 * less the wall is half the RAM: the 4G floor belongs to an unreadable
 * `/proc/meminfo`, and applying it to a 4 GiB box made the slice the whole
 * machine, which is no sum wall at all.
 *
 * Below a 2 GiB wall the whole-GiB floor takes it back up: a 1 GiB box gets all
 * of it and a 1.5 GiB box two thirds, because a 512M slice is not a usable
 * wall. A container that small with its own user manager is outside this.
 */
export function sliceMemoryMax(meminfo: string, appBytes = 0): string {
  const total = memTotal(meminfo);
  // An unreadable /proc/meminfo is not "no wall for the workers": it is the
  // floor, the same answer a small laptop gets.
  if (total === 0) return wholeGiB(SLICE_RESERVE_MIN);
  const reserve = Math.min(
    total / 2,
    Math.max(SLICE_RESERVE_MIN, total * SLICE_RESERVE_SHARE, appBytes + SLICE_APP_HEADROOM),
  );
  return wholeGiB(total - reserve);
}

/** Just under the slice's wall in whole GiB, so `MemoryHigh` throttles the
 *  workers where `MemoryMax` would kill one: 20G→18G, 42G→37G. Whole-GiB
 *  rounding makes that a quarter on the 4G wall an 8G machine gets; a wall with
 *  no whole GiB under it (1G, 512M) is its own throttle rather than a
 *  `MemoryHigh` above it. */
export function sliceMemoryHigh(max: string): string {
  const bytes = sizeBytes(max);
  if (bytes <= 0) return max;
  const under = sizeBytes(wholeGiB(bytes * SLICE_HIGH_SHARE));
  return under > 0 && under < bytes ? wholeGiB(under) : max;
}

/** A cgroup's `memory.current` in bytes, or 0 when it cannot be read. */
function cgroupBytes(path: string): number {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

/**
 * The cgroup directory a slice gets under `app.slice`. systemd makes `a-b.slice`
 * a child of `a.slice`, so `app-agentglass-workers.slice` lives one level below
 * `app.slice/app-agentglass.slice`; `app.slice/<the slice>` never exists. The
 * caller starts at the `app` the unit's name begins with.
 */
function sliceCgroup(app: string, unit: string): string {
  const parts = unit.trim().replace(/\.slice$/, "").split("-");
  let dir = app;
  for (let i = 1; i < parts.length; i++) dir = join(dir, `${parts.slice(0, i + 1).join("-")}.slice`);
  return dir;
}

/**
 * What the app's own cgroup holds right now, less the worker slice inside it,
 * or 0 when it cannot be read.
 *
 * Measured 11.75-12.16 GiB on a 30.45 GiB machine with the worker slice empty,
 * against the 10.45G a third of RAM reserves there. Only this user's manager is
 * read — another login's app is not this machine's reserve — and the worker
 * slice is subtracted because it is a child of `app.slice` and a restart
 * measures it with its workers still in it: counting them would shrink the wall
 * every time the app came back.
 */
export function appSliceBytes(root = "/sys/fs/cgroup"): number {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return 0;
  const users = join(root, "user.slice", `user-${uid}.slice`);
  for (const manager of subdirs(users)) {
    const app = join(users, manager, "app.slice");
    const held = cgroupBytes(join(app, "memory.current"));
    if (held <= 0) continue;
    return Math.max(0, held - cgroupBytes(join(sliceCgroup(app, WORKER_SLICE), "memory.current")));
  }
  return 0;
}

/** The worker slice as the kernel has it, for the boot decision. */
export interface SliceNow {
  /** `memory.current` in bytes: only ever a number for the log. An empty cgroup
   *  keeps file and kernel charges, so this is not evidence of occupancy. */
  held: number;
  /** `memory.max` as the kernel prints it (`max` for none), or "". */
  max: string;
  /** True when a process lives anywhere in the slice's subtree, or a level of
   *  it could not be read. Unknown is not empty: it keeps the standing wall. */
  occupied: boolean;
}

/**
 * The worker slice as the kernel has it right now, or null when it is not
 * there. Read from the cgroup rather than through `systemctl` because this runs
 * before the first write of a boot and must not reorder that write.
 */
export function workerSliceFacts(root = "/sys/fs/cgroup"): SliceNow | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return null;
  const users = join(root, "user.slice", `user-${uid}.slice`);
  for (const manager of subdirs(users)) {
    const dir = sliceCgroup(join(users, manager, "app.slice"), WORKER_SLICE);
    if (!existsSync(dir)) continue;
    const held = cgroupBytes(join(dir, "memory.current"));
    let max = "";
    try { max = readFileSync(join(dir, "memory.max"), "utf8").trim(); } catch { /* no wall to name */ }
    const tree = cgroupTree(dir);
    // tree.own is pids systemd put straight into the slice's own cgroup, which
    // it never does — a process always lands in a nested scope or service
    // unit — so only the nested count can ever be nonzero here in production.
    return { held, max, occupied: tree === null || tree.nested.length > 0 };
  }
  return null;
}

/**
 * The switches, environment first. Off is the environment's `0`/`off` or the
 * file's `scopes: false`; the numbers are validated and fall back rather than
 * being passed to systemd.
 */
export function scopeSettings(
  env: NodeJS.ProcessEnv = process.env, cfg: ScopeConfig = {}, meminfo: string = readMeminfo(), appBytes = 0,
): ScopeSettings {
  const asked = (env.AGENTGLASS_SCOPES ?? "").trim().toLowerCase();
  // The environment is the one-off switch and wins when it is set at all; the
  // file is what a desktop launch, which inherits no environment, can use.
  const off = asked ? asked === "0" || asked === "off" : cfg.off === true;
  const memoryMax = validSize(env.AGENTGLASS_SCOPE_MEMORY_MAX) ?? validSize(cfg.memoryMax) ?? defaultMemoryMax(meminfo);
  const sliceAsked = validSize(envLimit("AGENTGLASS_SLICE_MEMORY_MAX", env)) ?? validSize(cfg.sliceMemoryMax);
  /* A configured wall larger than this machine can give is no wall, and a
     `config.json` copied from a bigger desktop is exactly how one arrives. The
     ceiling is the wall the reserve derives, app.slice included, so a
     configured value cannot buy more than this machine's app and desktop
     leave; `ensureWorkerSlice` says so once rather than silently. */
  const derived = sliceMemoryMax(meminfo, appBytes);
  const ceiling = sizeBytes(derived);
  const clamped = sliceAsked !== null && ceiling > 0 && sizeBytes(sliceAsked) > ceiling;
  const sliceMax = clamped ? derived : sliceAsked ?? derived;
  const hours = Number(env.AGENTGLASS_SCOPE_MAX_AGE_H ?? cfg.maxAgeHours);
  const maxAgeH = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_AGE_H;
  return {
    on: !off, memoryMax, slice: WORKER_SLICE,
    sliceMemoryMax: sliceMax, sliceMemoryHigh: sliceMemoryHigh(sliceMax),
    ...(clamped ? { sliceClamped: true } : null),
    maxAgeMs: maxAgeH * 60 * 60_000,
  };
}

/** What the page shows when the environment holds the ceiling: the variable and its value, or null. */
export function memoryMaxEnv(env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | null {
  const v = validSize(env.AGENTGLASS_SCOPE_MEMORY_MAX);
  return v ? { name: "AGENTGLASS_SCOPE_MEMORY_MAX", value: v } : null;
}

/** The same answer from the file, this machine's environment, and what the
 *  app's own cgroup already holds (the reserve a third of RAM gives can be
 *  less than that). */
export function scopesFor(): ScopeSettings {
  return scopeSettings(process.env, scopeConfig(), readMeminfo(), appSliceBytes());
}

/** `systemd-run` as this machine has it, resolved from the PATH the child will
 *  actually be given (Bun.which reads the process's own PATH otherwise).
 *  `--user` also needs the user manager's socket: without `XDG_RUNTIME_DIR` it
 *  cannot be reached, and wrapping would turn a working launch into a failed
 *  one, so an environment without it is the plain path. */
export function systemdRun(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.XDG_RUNTIME_DIR) return null;
  try {
    return Bun.which("systemd-run", { PATH: env.PATH ?? "" }) ?? null;
  } catch {
    return null;
  }
}

let launched = 0;
/** A per-run suffix as well as the pid: a name is remembered for an exit that
 *  may never come, and a later process can be handed a pid that an uncollected
 *  unit still carries. */
const RUN = Math.random().toString(36).slice(2, 8);
/** One name per launch, and the pid in it so two servers never share one. */
export function nextUnitName(): string {
  launched += 1;
  return `${SCOPE_PREFIX}${process.pid}-${RUN}-${launched}`;
}

/** True while launches carry `--slice=`. False until a check or a write says the
 *  slice has a wall, which is exactly the argv this app had before it existed.
 *  A failed attempt is retried on the sweep's clock (index.ts). */
let sliceUsable = false;
/** True once the slice has been checked or written, so the first success is not
 *  announced as a recovery from a failure that never happened. */
let sliceChecked = false;
/** The wall the slice was actually given, kept from the moment its setting was
 *  accepted: `app.slice`'s live size moves, and a wall recomputed at report
 *  time can name a number nobody wrote. Null until a check or a write succeeds. */
let sliceWall: string | null = null;
/** One line per reason: a machine without a slice is not told again on every
 *  launch, and a slice that comes back after a failed attempt says so once —
 *  the journal would otherwise end on "not in one slice". */
const saidFallback = new Set<string>();

export interface Scoped {
  argv: string[];
  /** The transient unit, or null when this launch is not scoped. */
  unit: string | null;
}

/**
 * The argv to launch, wrapped in its own scope when this machine can do that.
 * Pure given `run`, `slice` and `settings`, which is how the off switch, the
 * missing binary and a slice that could not be made are table rows rather than
 * an environment nobody has; an omitted `slice` is whatever `ensureWorkerSlice`
 * last answered, so a machine that cannot have the slice launches as it did.
 */
export function scopeArgv(
  argv: readonly string[],
  o: { settings?: ScopeSettings; run?: string | null; unit?: string; slice?: string | null } = {},
): Scoped {
  const s = o.settings ?? scopesFor();
  const run = o.run === undefined ? systemdRun() : o.run;
  if (!s.on || !run) return { argv: [...argv], unit: null };
  const unit = o.unit ?? nextUnitName();
  const slice = o.slice === undefined ? (sliceUsable ? s.slice : null) : o.slice;
  return {
    argv: [
      // --quiet keeps systemd's own "Running as unit: …" out of a probe's
      // stderr, where it would be read as the engine's error line.
      run, "--quiet", "--user", "--scope", "--collect", `--unit=${unit}`,
      ...(slice ? [`--slice=${slice}`] : []),
      "-p", `MemoryMax=${s.memoryMax}`, "-p", "MemorySwapMax=0",
      "--", ...argv,
    ],
    unit,
  };
}

/**
 * The argv that gives the slice its walls: `systemctl --user set-property
 * --runtime` writes a drop-in under `/run` and the limits reach the slice's
 * cgroup at once. `systemd-run --slice=` only places a scope in a slice — it
 * carries the scope's properties, not the slice's — so a slice made that way
 * is created implicitly with no ceiling at all.
 */
export function sliceArgv(s: ScopeSettings): string[] {
  return [
    "systemctl", "--user", "set-property", "--runtime", s.slice,
    `MemoryMax=${s.sliceMemoryMax}`, `MemoryHigh=${s.sliceMemoryHigh}`,
  ];
}

/** How the slice is given its walls; a test passes its own so no real unit is
 *  ever started. */
export type SliceRunner = (argv: readonly string[]) => boolean;

function realSliceRunner(argv: readonly string[]): boolean {
  try {
    const r = spawnSyncAs("scope run", [...argv], { stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 10_000 });
    return r.success;
  } catch { return false; }
}

/** One `key=value` property from `systemctl show`, or null when it is absent. */
function showField(out: string, name: string): string | null {
  for (const line of out.split("\n")) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  return null;
}

/** The slice's effective `MemoryMax` as systemd reports it, or null. */
function realSliceRead(unit: string): string | null {
  const out = spawnOut(["systemctl", "--user", "show", "-p", "MemoryMax", "--", unit]);
  return out === null ? null : showField(out, "MemoryMax");
}

/** The largest whole unit a byte count makes, so systemd's `21474836480` reads
 *  as `20G` and a configured `300M` does not become `1G`. */
function bytesLabel(bytes: number): string {
  for (const [unit, size] of [["T", 2 ** 40], ["G", 2 ** 30], ["M", 2 ** 20], ["K", 2 ** 10]] as const) {
    if (bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return `${bytes}`;
}

/** A wall as a size systemd takes, with the bytes it stands for: the comparison
 *  is the bytes, and the label is only ever logged. `systemctl --user show -p
 *  MemoryMax` prints bytes (`21474836480`, `314572800`) and `infinity` for
 *  none; a configured one is `20G`. `infinity` and `max` are the absence of a
 *  wall. */
function wallLabel(raw: string): { label: string; bytes: number } | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const bytes = Number(s);
    return Number.isFinite(bytes) && bytes > 0 ? { label: bytesLabel(bytes), bytes } : null;
  }
  const label = validSize(s);
  return label === null ? null : { label, bytes: sizeBytes(label) };
}

export function workerSliceUsable(): boolean {
  return sliceUsable;
}

/** The slice's `MemoryMax` as it was applied, or null when none was. */
export function appliedSliceMemoryMax(): string | null {
  return sliceWall;
}

/**
 * Give the worker slice its walls, before the first scope lands in it, and
 * again on every later call: a worker scope created by another process (a
 * second agentglass window, a CLI launch) between this call's occupancy read
 * and the one that set `sliceUsable` is invisible to that earlier snapshot, so
 * a successful write is not the end of the story. index.ts keeps calling this
 * on its sweep clock regardless of `sliceUsable`, and the "keep the standing
 * wall" branch below only ever raises a wall that turns out to have been
 * written too small — it never lowers one under live workers — so a stale
 * write heals itself once the slice is next seen occupied.
 * Best effort on purpose: no user manager (macOS, CI, a bare container) or a
 * `systemctl` that will not take the properties leaves the per-scope wall
 * alone, says why once, and never fails a launch or a start.
 */
export function ensureWorkerSlice(d: {
  settings?: ScopeSettings;
  /** `null` stands in for "no systemd-run here"; a test passes its own. */
  run?: SliceRunner | null;
  /** Read the slice's effective `MemoryMax` instead of writing it. Every
   *  process that is not the app's own copy does this before launching into it:
   *  the drop-in is machine-wide, so a server started by hand must not set it. */
  readOnly?: boolean;
  /** The effective `MemoryMax`, or null when it cannot be read. A test supplies
   *  its own so no real unit is ever queried. */
  read?: (unit: string) => string | null;
  /** The slice as the kernel has it now, read before a write so a boot never
   *  lowers the wall under workers already in it. A test supplies its own: an
   *  injected `run` writes no real unit, so the real cgroup would say nothing
   *  about it. */
  sliceNow?: () => SliceNow | null;
  log?: (line: string) => void;
} = {}): boolean {
  const s = d.settings ?? scopesFor();
  // Nothing is scoped at all: there is no slice to speak of.
  if (!s.on) {
    sliceUsable = false;
    sliceWall = null;
    sliceChecked = true;
    return false;
  }
  const log = d.log ?? ((line: string) => { console.log(line); });
  let why = "no user systemd on this machine";
  let ok = false;
  let wall: string | null = null;
  if (d.readOnly) {
    const raw = (d.read ?? realSliceRead)(s.slice);
    const read = raw === null ? null : wallLabel(raw);
    wall = read === null ? null : read.label;
    ok = wall !== null;
    if (!ok) {
      why = raw === null
        ? `the slice ${s.slice} could not be read`
        : `the slice ${s.slice} has no ceiling (${raw})`;
    }
  } else {
    const run = d.run === undefined ? (systemdRun() ? realSliceRunner : null) : d.run;
    if (run) {
      /* Never lower the wall under live workers: measured on a 30.45G box with
         app.slice at 12.35G, a 20G setting derives 17G/15G, and three workers
         holding 18G would be throttled at 15G before adoption runs. The
         standing wall wins while the slice is occupied; an empty one takes the
         new wall, so it is not kept for ever. */
      const now = d.sliceNow ? d.sliceNow() : (d.run === undefined ? workerSliceFacts() : null);
      const standing = now === null ? null : wallLabel(now.max);
      const occupied = now !== null && now.occupied;
      const keep = occupied && standing !== null && standing.bytes > sizeBytes(s.sliceMemoryMax);
      const applied = keep && standing !== null
        ? { ...s, sliceMemoryMax: standing.label, sliceMemoryHigh: sliceMemoryHigh(standing.label) }
        : s;
      if (occupied && standing === null) {
        // An unwalled or unreadable slice with workers in it would be walled
        // under them by writing: unknown is not permission to lower it.
        ok = false;
        why = `the slice ${s.slice} holds workers and has no wall this boot can read; left alone rather than lowered under them`;
      } else {
        try { ok = run(sliceArgv(applied)); } catch { ok = false; }
        if (!ok) why = `the slice ${s.slice} would not take its ceiling`;
        else {
          wall = applied.sliceMemoryMax;
          // Only a write that landed says a clamp was applied; a kept standing
          // wall is not this boot's clamp to announce.
          const clamp = `clamped:${s.slice}:${s.sliceMemoryMax}`;
          if (s.sliceClamped && wall === s.sliceMemoryMax && !saidFallback.has(clamp)) {
            saidFallback.add(clamp);
            log(`🧹 scopes: the worker slice was clamped to ${s.sliceMemoryMax} — larger than this machine's app and desktop leave free`);
          }
          if (keep && now !== null && standing !== null) {
            log(`🧹 scopes: the worker slice keeps ${standing.label} — it holds ${bytesLabel(now.held)} and this boot would have lowered it to ${s.sliceMemoryMax}`);
          }
        }
      }
    }
  }
  const was = sliceUsable;
  const first = !sliceChecked;
  sliceChecked = true;
  sliceUsable = ok;
  sliceWall = wall;
  // Once per slice: the journal would otherwise end on "not in one slice".
  const back = `back:${s.slice}`;
  if (ok && !first && !was && !saidFallback.has(back)) {
    saidFallback.add(back);
    log(`🧹 scopes: the workers are back in ${s.slice} — their sum is bounded again`);
  }
  if (!ok && !saidFallback.has(why)) {
    saidFallback.add(why);
    log(`🧹 scopes: workers are not in one slice — ${why}; each keeps its own ${s.memoryMax} ceiling and their sum has no wall`);
  }
  return ok;
}

/** What the boot pass did with the slice's old name. */
export type LegacySliceOutcome = "absent" | "kept" | "stopped" | "failed" | "unknown";

/**
 * The slice this feature used before it moved under `app.slice` is a sibling of
 * `app.slice`, which oomd does not watch, and it outlives the upgrade that
 * renamed it. Once nothing is in it, stop it by name; a unit with a process
 * still in it is left alone and said so, because that process is a live worker
 * the new code cannot adopt. An unreadable unit is unknown, not empty.
 */
export function retireLegacySlice(d: {
  /** `systemctl --user show -p LoadState -p ActiveState -p ControlGroup -- <unit>`. */
  show?: (unit: string) => string | null;
  /** Every pid in the unit's cgroup, or null when it cannot be read. */
  procs?: (group: string) => number[] | null;
  stop?: UnitStop;
  log?: (line: string) => void;
} = {}): LegacySliceOutcome {
  const out = (d.show ?? realUnitShow)(LEGACY_WORKER_SLICE);
  if (out === null) return "unknown";
  // Only a live unit has a cgroup to empty and workers outside the new wall.
  if (showField(out, "LoadState") !== "loaded" || showField(out, "ActiveState") !== "active") return "absent";
  const group = showField(out, "ControlGroup") ?? "";
  if (!group.startsWith("/") || !group.endsWith(`/${LEGACY_WORKER_SLICE}`)) return "unknown";
  const log = d.log ?? ((line: string) => { console.log(line); });
  const pids = (d.procs ?? groupProcs)(group);
  if (pids === null) {
    log(`🧹 scopes: the old worker slice ${LEGACY_WORKER_SLICE} is still loaded and could not be read; left alone`);
    return "unknown";
  }
  if (pids.length) {
    const count = `${pids.length} process${pids.length === 1 ? "" : "es"}`;
    log(`🧹 scopes: the old worker slice ${LEGACY_WORKER_SLICE} is still loaded with ${count}; left alone`);
    return "kept";
  }
  let stopped = true;
  try { stopped = (d.stop ?? realStopUnit)(LEGACY_WORKER_SLICE) !== false; } catch { stopped = false; }
  log(stopped
    ? `🧹 scopes: stopped the old worker slice ${LEGACY_WORKER_SLICE} — it held no process and sits outside the wall the workers share`
    : `🧹 scopes: the old worker slice ${LEGACY_WORKER_SLICE} is empty and did not stop`);
  return stopped ? "stopped" : "failed";
}

function realUnitShow(unit: string): string | null {
  return spawnOut(["systemctl", "--user", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "ControlGroup", "--", unit]);
}

/**
 * Every pid in a unit's cgroup and in every cgroup below it, or null when a
 * level could not be read. A slice's own `cgroup.procs` is always empty — its
 * workers live in child scope units — so reading only the top level calls a
 * loaded legacy slice empty and stops it under live turns. Unknown is not
 * empty: null keeps it.
 */
export function groupProcs(group: string, root = "/sys/fs/cgroup"): number[] | null {
  const tree = cgroupTree(`${root}${group}`);
  return tree === null ? null : [...tree.own, ...tree.nested];
}

// ------------------------------------------------------- the scopes we own ----

/** Units this process started, so its exit can stop exactly them. */
const own = new Set<string>();

/** Remember a unit this process launched. Only our own child prefix is taken:
 *  the app's scope is never this process's to stop, and neither is a tmux
 *  server's parent unit. */
export function rememberScope(unit: string): boolean {
  if (!unit.startsWith(SCOPE_PREFIX)) return false;
  own.add(unit);
  return true;
}

export function ownScopes(): ReadonlySet<string> {
  return own;
}

/** `systemctl --user stop <unit>` and nothing else. Injected so a test never
 *  talks to the real user manager. False says the stop itself failed. */
export type UnitStop = (unit: string) => boolean | void;

function realStop(unit: string): boolean {
  try {
    const r = spawnSyncAs("systemctl stop", ["systemctl", "--user", "stop", unit], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 5_000,
    });
    return r.success;
  } catch { return false; /* no user manager: the scope is the exit's only casualty */ }
}

/**
 * Stop the scopes this process started, on the way out. Synchronous by
 * necessity: this runs from `process.on("exit")`, where nothing is awaited.
 */
export function stopOwnScopes(stop: UnitStop = realStop): string[] {
  // Every writer goes through rememberScope, which refuses anything outside
  // SCOPE_PREFIX: the app's own scope and a tmux unit are never in here.
  const units = [...own];
  own.clear();
  for (const unit of units) {
    try { stop(unit); } catch { /* the next sweep sees it, if anything is left */ }
  }
  return units;
}

let armed = false;
function armExit(): void {
  if (armed) return;
  armed = true;
  process.on("exit", () => { stopOwnScopes(); });
}

/** Remember a launch's unit, if it got one, and arm the exit stop. */
export function trackScope(unit: string | null): void {
  if (unit && rememberScope(unit)) armExit();
}

/** The scope ONE RUN of a worker was launched in, by worker name. A headless
 *  turn's private OpenCode server has a scope of its own (agents/opencodeserve.ts),
 *  and the window that turn opened is when nothing is left in it. */
const runScope = new Map<string, string>();

/** A new turn replaces the last one's scope: the map is the run in flight, not
 *  a history. A turn STARTING under a reused name does not end the previous
 *  window's scope (agentops.ts `turnStarted`), so nothing is stopped by the
 *  note itself; it only moves where the next window-end looks. */
export function noteRunScope(name: string, unit: string | null): void {
  if (unit && unit.startsWith(SCOPE_PREFIX)) runScope.set(name, unit);
  else runScope.delete(name);
}

/**
 * The window a run belonged to is gone — stopped, started over under the name,
 * or the tab reconciled away — and with it the whole scope: the serve, the
 * turn's bash tools, and anything the turn left running on purpose (a dev
 * server it told the person to look at). A turn ENDING is not this moment: the
 * wrapper stops the private server at turn end (agents/headless.ts
 * `AGX_SERVE_PIDS`) and the rest belongs to the window.
 *
 * The unit is forgotten only after the stop answered true, so a `systemctl`
 * that failed or threw leaves it in `own` for the exit pass to try again.
 */
export function endWindowScopes(name: string, stop: UnitStop = realStop): string[] {
  const unit = runScope.get(name);
  if (!unit) return [];
  let stopped = true;
  try { stopped = stop(unit) !== false; } catch { stopped = false; }
  if (!stopped) return [];
  runScope.delete(name);
  own.delete(unit);
  return [unit];
}

/** `oom_kill` from a cgroup's `memory.events`, 0 when the line is not there. */
export function oomKills(events: string): number {
  const m = events.match(/^oom_kill\s+(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

/** A scope's `memory.events`, or null when the unit's cgroup cannot be read. */
function realMemoryEvents(unit: string): string | null {
  const out = spawnOut(["systemctl", "--user", "show", "-p", "MainPID", "-p", "ControlGroup", "--", unit]);
  if (out === null) return null;
  const shown = parseShow(out);
  const group = shown ? ownCgroup(unit, shown.controlGroup) : null;
  if (group === null) return null;
  try { return readFileSync(`/sys/fs/cgroup${group}/memory.events`, "utf8"); } catch { return null; }
}

/**
 * The ceiling that bound a child when the kernel OOM-killed something in the
 * run's scope: what the worker's end reason says instead of the engine's
 * `ECONNRESET`. Null when the run has no scope (a TUI turn), when the scope
 * cannot be read — unknown is not a kill — or when `oom_kill` is 0.
 *
 * The count is this turn's: a unit is minted per launch (`nextUnitName`), so a
 * scope the turn owns starts at zero and the next turn never lands in it.
 *
 * Which wall: an OOM kill raised by the slice's `memory.max` still lands in the
 * child's own `memory.events` (measured 2026-11-05: `oom_kill 1` in a scope
 * whose own `max` was 0), and the counter cannot say which `memory.max` fired.
 * So the sentence names both numbers — "7G, shared 20G" — instead of reporting
 * the per-scope ceiling alone as if it were the wall that bound.
 */
export function runOutOfMemory(
  name: string,
  deps: {
    unit?: string | null;
    ceiling?: string;
    /** The shared wall, or null when this process is not using the slice.
     *  Defaults to the wall this process applied, while launches carry it. */
    sliceCeiling?: string | null;
    events?: (unit: string) => string | null;
  } = {},
): string | null {
  const unit = deps.unit === undefined ? runScope.get(name) ?? null : deps.unit;
  if (!unit) return null;
  const events = (deps.events ?? realMemoryEvents)(unit);
  if (events === null || oomKills(events) === 0) return null;
  const scope = deps.ceiling ?? scopesFor().memoryMax;
  const shared = deps.sliceCeiling === undefined
    ? (workerSliceUsable() ? appliedSliceMemoryMax() : null)
    : deps.sliceCeiling;
  if (!shared) return scope;
  return `${scope}, shared ${shared}`;
}

// ------------------------------------------------------------ the reaper ----

/** A process in a cgroup below the scope's own. The pid travels with the comm
 *  because the age of that pid is evidence too: a turn that started a minute
 *  ago is one cgroup down as often as it is here. */
export interface HeldProc {
  pid: number;
  /** `comm`, or `""` when the read failed — unknown, which keeps the scope. */
  comm: string;
}

export interface ScopeFact {
  unit: string;
  /** 0 when the scope has no main process at all. */
  mainPid: number;
  /** Every process still in the scope's cgroup. */
  procs: number[];
  /** `comm` of each process in `procs`, in the same order. `""` is a read that
   *  failed, which is unknown — and unknown keeps the scope. */
  comms: string[];
  /** Every process in a cgroup nested under the scope's own. Null when one of
   *  them could not be read: unknown again, so the scope is kept. */
  nested: HeldProc[] | null;
}

/** Every pid the scope holds, its own cgroup and every level below, or null
 *  when a level nobody could read leaves the set unknown. */
function heldPids(f: ScopeFact): number[] | null {
  if (f.nested === null) return null;
  return [...f.procs, ...f.nested.map((n) => n.pid)];
}

/** True when the scope must be kept whatever its age says: a tmux is running
 *  somewhere in it, or a comm nobody could read. A scope that cannot be
 *  described — comms missing for a pid, a whole level unread — is not a
 *  leftover. */
export function holdsLiveWork(
  procs: readonly number[], comms: readonly string[], nested: readonly HeldProc[] | null,
): boolean {
  if (comms.length !== procs.length) return true;
  if (nested === null) return true;
  for (const c of comms) if (c === "" || c.startsWith("tmux")) return true;
  for (const n of nested) if (n.comm === "" || n.comm.startsWith("tmux")) return true;
  return false;
}

/** The server pid a child scope's name carries (`agentglass-child-<pid>-…`), or
 *  null. The name is the identity: it is minted at launch and never matches on
 *  what the process happens to be called. */
export function childScopeOwner(unit: string): number | null {
  if (!unit.startsWith(SCOPE_PREFIX)) return null;
  const pid = Number(unit.slice(SCOPE_PREFIX.length).split("-")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The rest of the rule, as a table: something is still in the scope, it is not
 *  this server, and its youngest process — its own cgroup or one below — is
 *  older than the ceiling. The leader half is asked by the caller, which has
 *  the liveness answer. */
export function staleAppScope(f: ScopeFact, youngestMs: number, minAgeMs: number, selfPid: number): boolean {
  if (!f.unit.startsWith(APP_SCOPE_PREFIX)) return false;
  // The leader dying empties the scope's own cgroup and leaves the payloads a
  // level down, so only a scope empty at every level is nothing to reap.
  if (f.procs.length === 0 && !f.nested?.length) return false;
  if (f.procs.includes(selfPid)) return false;
  if (holdsLiveWork(f.procs, f.comms ?? [], f.nested ?? null)) return false;
  return youngestMs > minAgeMs;
}

/** A child scope this app started, whose server is gone: the same ceiling, and
 *  the owner is the pid in the unit's name rather than a MainPID (the payload
 *  of a scope is alive by definition, which is the point of stopping it). A
 *  tmux server in it is a live agent pane, not a leftover. */
export function staleChildScope(
  unit: string, youngestMs: number, minAgeMs: number, selfPid: number,
  ownerPid: number | null, ownerAlive: boolean, procs: readonly number[],
  comms: readonly string[], nested: readonly HeldProc[] | null = null,
): boolean {
  if (!unit.startsWith(SCOPE_PREFIX)) return false;
  if (ownerPid === null || ownerAlive) return false;
  if ((procs.length === 0 && !nested?.length) || procs.includes(selfPid)) return false;
  if (holdsLiveWork(procs, comms, nested)) return false;
  return youngestMs > minAgeMs;
}

/** `systemctl --user list-units --type=scope --all --no-legend --plain`, as unit names.
 *  Null when the command failed: an unread list is not "no scopes". */
export function scopeUnits(out: string): string[] {
  const units: string[] = [];
  for (const line of out.split("\n")) {
    const name = line.trim().split(/\s+/)[0] ?? "";
    if (!name.endsWith(".scope")) continue;
    units.push(name);
  }
  return units;
}

/** `systemctl --user show -p MainPID -p ControlGroup <unit>`, as `key=value`
 *  lines. `--value` is not used: it drops a property that is empty, and an
 *  empty MainPID is exactly the dead leader this looks for. */
export function parseShow(out: string): { mainPid: number; controlGroup: string } | null {
  const fields = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const controlGroup = fields.get("ControlGroup") ?? "";
  const rawPid = fields.get("MainPID");
  const mainPid = rawPid === undefined || rawPid === "" ? 0 : Number(rawPid);
  if (!controlGroup.startsWith("/") || !Number.isInteger(mainPid) || mainPid < 0) return null;
  return { mainPid, controlGroup };
}

/** The cgroup that holds exactly this unit's processes, or null. A unit's own
 *  cgroup is the directory named after it, so the path ends with the unit's
 *  name; the root and a shared ancestor do not, and descending into one would
 *  read every slice on the machine as this unit's. */
export function ownCgroup(unit: string, controlGroup: string): string | null {
  if (!controlGroup.startsWith("/") || !controlGroup.endsWith(`/${unit}`)) return null;
  return controlGroup;
}

/** The pids in a cgroup, or null when it cannot be read. */
export function cgroupProcs(dir: string): number[] | null {
  try {
    return readFileSync(`${dir}/cgroup.procs`, "utf8")
      .split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return null;
  }
}

/** How deep a subtree one scope may hold, and how many cgroups it may hold in
 *  all. Past either the scope reads as unknown and is kept: the ceiling is far
 *  past any real topology, and a level nobody finished reading is not empty. */
export const MAX_TREE_DEPTH = 32;
export const MAX_TREE_CGROUPS = 512;

/** A cgroup's own pids and every pid in a cgroup below it. A session scope
 *  nested in an app scope is stopped with it, so its processes are the parent's
 *  too. Null when any level could not be read, or the tree runs past a bound —
 *  unknown is not empty. */
export function cgroupTree(
  dir: string, maxDepth = MAX_TREE_DEPTH, maxCgroups = MAX_TREE_CGROUPS,
): { own: number[]; nested: number[] } | null {
  const own = cgroupProcs(dir);
  if (own === null) return null;
  const nested: number[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  let seen = 0;
  while (stack.length) {
    const at = stack.pop()!;
    let entries;
    try { entries = readdirSync(at.dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (at.depth + 1 > maxDepth) return null;
      if (++seen > maxCgroups) return null;
      const sub = join(at.dir, e.name);
      const pids = cgroupProcs(sub);
      if (pids === null) return null;
      nested.push(...pids);
      stack.push({ dir: sub, depth: at.depth + 1 });
    }
  }
  return { own, nested };
}

/** `comm` of one pid, or `""`: a read that failed is unknown, which keeps the
 *  scope. */
function commOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; }
}

/** Each pid with its comm, in the order the cgroup listed them. */
function heldOf(pids: readonly number[]): HeldProc[] {
  return pids.map((pid) => ({ pid, comm: commOf(pid) }));
}

function uptimeSec(): number | null {
  try {
    const n = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Milliseconds a pid has lived, from `/proc/<pid>/stat` field 22 and the same
 *  uptime every other module reads. Null when the pid is gone. */
export function ageMsOf(pid: number, uptime: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    if (!Number.isFinite(ticks)) return null;
    return Math.max(0, (uptime - ticks / 100) * 1000);
  } catch { return null; }
}

export interface ReapScopesDeps {
  /** Unit names, or null when the list could not be read. */
  list?: () => string[] | null;
  fact?: (unit: string) => ScopeFact | null;
  /** Milliseconds, by pid. Nulls are dropped. */
  ageMs?: (pids: readonly number[]) => Map<number, number>;
  alive?: (pid: number) => boolean;
  stop?: UnitStop;
  /** One line per stop, so the next sweep can be attributed. Defaults to the
   *  server's own log. */
  log?: (line: string) => void;
  /** Units this sweep must leave alone whatever their age says: the scopes the
   *  boot pass adopted for a turn that was in flight (index.ts). Age is not a
   *  fact about a live turn, and a ceiling below one turn's length is a
   *  legitimate setting. */
  keep?: () => ReadonlySet<string>;
  minAgeMs?: number;
  selfPid?: number;
}

function spawnOut(argv: string[]): string | null {
  try {
    const r = spawnSyncAs("scope probe argv", argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000 });
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch { return null; }
}

function realList(): string[] | null {
  const out = spawnOut(["systemctl", "--user", "list-units", "--type=scope", "--all", "--no-legend", "--plain"]);
  return out === null ? null : scopeUnits(out);
}

function realFact(unit: string): ScopeFact | null {
  const out = spawnOut(["systemctl", "--user", "show", "-p", "MainPID", "-p", "ControlGroup", "--", unit]);
  if (out === null) return null;
  const shown = parseShow(out);
  if (!shown) return null;
  const group = ownCgroup(unit, shown.controlGroup);
  if (group === null) return null;
  const tree = cgroupTree(`/sys/fs/cgroup${group}`);
  if (tree === null) return null;
  return {
    unit, mainPid: shown.mainPid, procs: tree.own, comms: tree.own.map(commOf), nested: heldOf(tree.nested),
  };
}

function realAges(pids: readonly number[]): Map<number, number> {
  const up = uptimeSec();
  const out = new Map<number, number>();
  if (up === null) return out;
  for (const pid of pids) {
    const age = ageMsOf(pid, up);
    if (age !== null) out.set(pid, age);
  }
  return out;
}

function realStopUnit(unit: string): boolean {
  return spawnOut(["systemctl", "--user", "stop", "--", unit]) !== null;
}

/** A scope the sweep decided to stop, with what the decision was read from. */
interface Picked {
  unit: string;
  fact: ScopeFact;
  youngestMs: number;
  isApp: boolean;
  owner: number | null;
}

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

/** What a stop owes the log: the unit, what was in it — own cgroup and below —
 *  and the reading that made it a leftover. */
function stopLine(p: Picked, minAgeMs: number): string {
  const nested = (p.fact.nested ?? []).map((n) => `${n.pid}:${n.comm}`);
  const inScope = [...p.fact.procs.map((pid, i) => `${pid}:${p.fact.comms[i]}`), ...nested].join(" ");
  const why = p.isApp
    ? `app scope, leader ${p.fact.mainPid || "none"} not running`
    : `child scope, owner ${p.owner ?? "?"} not running`;
  return `🧹 scopes: stopping ${p.unit} — ${why}, youngest ${hours(p.youngestMs)} over ${hours(minAgeMs)}, no tmux; in it: ${inScope || "none"}`;
}

/** What the stop itself answered, so a stop that failed is not read as a stop
 *  that was slow: without this the journal shows the same intention for ever. */
function outcomeLine(unit: string, stopped: boolean): string {
  return stopped
    ? `🧹 scopes: ${unit} stopped`
    : `🧹 scopes: ${unit} did not stop — systemctl --user stop failed, the next sweep tries again`;
}

/**
 * Stop the app scopes nobody is behind any more. Nothing is stopped on a list,
 * a fact or an age that could not be read: a failed read is not a fact about a
 * scope, and the cost of waiting is another sweep.
 */
export function reapStaleScopes(deps: ReapScopesDeps = {}): string[] {
  const units = (deps.list ?? realList)();
  if (!units) return [];
  const minAgeMs = deps.minAgeMs ?? scopesFor().maxAgeMs;
  const selfPid = deps.selfPid ?? process.pid;
  const ageMs = deps.ageMs ?? realAges;
  const alive = deps.alive ?? pidAlive;
  const stop = deps.stop ?? realStopUnit;
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const keep = (deps.keep ?? (() => new Set<string>()))();
  const picked: Picked[] = [];
  for (const unit of units) {
    if (keep.has(unit)) continue;
    const isApp = unit.startsWith(APP_SCOPE_PREFIX);
    if (!isApp && !unit.startsWith(SCOPE_PREFIX)) continue;
    const fact = (deps.fact ?? realFact)(unit);
    if (!fact || fact.unit !== unit) continue;
    // A live leader owns its children: this is a running app, not a leftover.
    if (isApp && fact.mainPid > 0 && alive(fact.mainPid)) continue;
    const held = heldPids(fact);
    if (held === null) continue; // a level nobody could read: unknown, keep it
    const ages = ageMs(held);
    if (ages.size !== held.length) continue; // a pid that vanished mid-read
    const youngest = held.length ? Math.min(...ages.values()) : 0;
    const owner = isApp ? null : childScopeOwner(unit);
    const stale = isApp
      ? staleAppScope(fact, youngest, minAgeMs, selfPid)
      : staleChildScope(unit, youngest, minAgeMs, selfPid, owner, owner !== null && alive(owner), fact.procs, fact.comms, fact.nested);
    if (stale) picked.push({ unit, fact, youngestMs: youngest, isApp, owner });
  }
  for (const p of picked) {
    log(stopLine(p, minAgeMs));
    let stopped = true;
    try { stopped = stop(p.unit) !== false; } catch { stopped = false; }
    log(outcomeLine(p.unit, stopped));
  }
  return picked.map((p) => p.unit);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ------------------------------- what a server that is gone left behind ----

/*
 * A CHILD SCOPE OUTLIVES THE SERVER THAT MADE IT, AND ONE OF THEM CAN BE A
 * WORKER STILL WORKING.
 *
 * Measured on one machine on 2026-11-04 after a restart: five
 * `agentglass-child-*` scopes whose server pid was long dead still held a
 * finished `opencode` run, tmux servers a probe had started, and an adb
 * fork-server from a worktree that no longer existed — about 1.3 GB, none of it
 * doing anything. The sweep in this file only reads a scope's age, and a scope
 * whose children die is collected at once (`--collect`), so what is left is
 * exactly the case where some child refused to die.
 *
 * So the boot pass asks one question the age cannot: is anybody still working
 * in there? A scope a live turn owns is ADOPTED — left alone, and listed by
 * `memoryWatch` with the others — because a restart is not the end of a worker
 * and killing its private server under it is a lost turn. Every other scope of
 * a dead server is stopped, by unit name, with no `pkill` and no pattern.
 *
 * WHAT COUNTS AS "SOMEBODY IS STILL WORKING" (the rule, and its ceiling): one
 * process in the scope that names a live turn's worker (`AGX_OWNER`), or is an
 * engine's private server, or has its working directory in the directory a
 * live registry row works in, keeps the whole scope. The serve and directory
 * clauses are what carry the FIRST boot after an upgrade: every serve then in
 * flight was started by the build before this one, which stamped no
 * `AGX_OWNER`, and ownership alone would stop exactly the turns this pass was
 * written to save.
 *
 * CEILING of that rule: the serve clause knows the one engine here with a
 * private server (OpenCode 2.x); a second one is a row in `engineServe`. A
 * process sitting in the same directory as somebody's live window — a shell in
 * the same checkout — keeps the scope while that window lives, which is a leak,
 * never a wrong stop. A directory two live rows work in binds the scope to
 * neither of them: unnamed, it is adopted and left to the age sweep. A live
 * turn whose processes are all gone from `/proc` between the cgroup read and
 * the environ read has gone: a pid that has left `/proc` says nothing and is
 * skipped, not read as doubt.
 *
 * CEILING, chosen: no age floor on this pass. A turn that started a second
 * before the restart is caught by adoption, not by being young, and an age
 * floor would only decide which leftovers survive one more reboot. What is
 * kept is what cannot be described: an environ or a cwd `/proc` refused for a
 * pid that is still there, a cgroup nobody could read, a comm that came back
 * empty, or a registry that could not be read at all. A TMUX does not keep a
 * scope here, unlike in the age sweep: an agent's pane is never scoped, so a
 * tmux in a dead server's scope was started by a probe or by a worker's own
 * command — the measurement above counted exactly those — and a live turn's
 * scope has already been adopted by its owner before this is asked. The cost of
 * waiting is the next boot; the cost of guessing is a live worker's server.
 *
 * A worker re-adopted after a restart keeps its scope, and is registered under
 * the name of the row it was found working for, so that window's end stops it
 * even though this process never launched it. The keep set is not frozen here:
 * every sweep asks the same `keepReason` question again, so a turn that ended
 * without that path leaves its scope to the age sweep. A scope this pass could
 * not describe is kept and recorded for the sweep that follows, never handed to
 * it as a leftover. The pass is the desktop app's own copy, like the sweep
 * above (`sweepsAppScopes`): a server somebody started by hand is the launcher
 * of nothing and has no business stopping another copy's children. The pid in
 * each name is what says whose a scope is, never its age.
 */

/** What one process says about who it works for: the name it carries, that it
 *  carries none, or that its environment could not be read. The third is not
 *  the second — a sandboxed or non-dumpable child hides its environ — and the
 *  boot pass keeps the scope on it. */
export type OwnerRead = { state: "owner"; name: string } | { state: "absent" } | { state: "unreadable" };

function realOwnerOf(pid: number): OwnerRead {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/environ`, "utf8"); }
  catch { return { state: "unreadable" }; }
  for (const entry of raw.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0 && entry.slice(0, at) === OWNER_VAR) return { state: "owner", name: entry.slice(at + 1) };
  }
  return { state: "absent" };
}

/** Whether a command line is an engine's private server: an OpenCode `serve`,
 *  the one engine here that runs one (agents/opencodeserve.ts), whatever
 *  wrapper starts it (`bun .../opencode serve` included). A `serve` under any
 *  other name — `tailscale serve` — is not an engine. */
export function engineServe(argv: readonly string[]): boolean {
  if (!argv.includes("serve")) return false;
  return argv.slice(0, 2).some((a) => basename(a) === "opencode");
}

function realServes(pid: number): boolean {
  try { return engineServe(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)); }
  catch { return false; } // gone: a process that vanished is no serve
}

/** The directory a pid works in, or null when `/proc` refused it — unknown, and
 *  unknown keeps the scope. */
function realCwdOf(pid: number): string | null {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return cwd.endsWith(" (deleted)") ? cwd.slice(0, -" (deleted)".length) : cwd;
  } catch { return null; }
}

/** A path with its links resolved, or itself: a row's directory and
 *  `/proc/<pid>/cwd` are only the same spelling once both are resolved (`/home`
 *  is a link on some machines, and a wrong path here is a wrong stop). */
function resolved(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

const within = (dir: string, cwd: string): boolean =>
  cwd === dir || cwd.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** The rows whose turn is in flight: the worker names, and the directory each
 *  turn works in (a row's `cwd` is the worktree or checkout the engine was
 *  started in). Null when the registry could not be read. */
export interface LiveTurns {
  names: ReadonlySet<string>;
  dirs: readonly string[];
  /** The worker whose row a `dirs` entry came from, when the caller knows it:
   *  that is how an adopted scope is registered for its window's end. */
  dirNames?: ReadonlyMap<string, string>;
}

/** A live directory worth matching a cwd against. An empty string and `/` are
 *  not: `resolved("")` is this server's own checkout, and `/` matches every
 *  path there is. Both are a row stored with a directory nobody works in, not
 *  a reason to keep every leftover scope.
 *
 *  A directory carries a worker's name only when ONE live row works there: two
 *  rows in one checkout are two windows and the evidence picks neither, so the
 *  scope is adopted unnamed and left to the age sweep. */
function liveDirs(live: LiveTurns): { dir: string; name?: string }[] {
  const rows: { dir: string; raw: string }[] = [];
  for (const raw of live.dirs) {
    if (!raw || raw === "/") continue;
    rows.push({ dir: resolved(raw), raw });
  }
  const perDir = new Map<string, number>();
  for (const r of rows) perDir.set(r.dir, (perDir.get(r.dir) ?? 0) + 1);
  return rows.map((r) => {
    const name = perDir.get(r.dir) === 1 ? live.dirNames?.get(r.raw) : undefined;
    return name ? { dir: r.dir, name } : { dir: r.dir };
  });
}

export interface OrphanScopesDeps {
  /** Unit names, or null when the list could not be read. */
  list?: () => string[] | null;
  fact?: (unit: string) => ScopeFact | null;
  alive?: (pid: number) => boolean;
  /** The three-state `AGX_OWNER` read of one pid. */
  ownerOf?: (pid: number) => OwnerRead;
  /** True when the pid's own command line is an engine's private server. */
  serves?: (pid: number) => boolean;
  /** The directory a pid works in, or null when it could not be read. */
  cwdOf?: (pid: number) => string | null;
  /** The registry rows whose turn is in flight, or null when the registry
   *  could not be read — unknown keeps every scope. */
  live?: () => LiveTurns | null;
  /** The switch the other sweep honours (`scopesFor().on`). Off means this pass
   *  does not touch systemd at all. */
  on?: boolean;
  stop?: UnitStop;
  log?: (line: string) => void;
  selfPid?: number;
}

export interface OrphanScopes {
  /** Left alone: a live worker's run is in there, or nothing could be read
   *  that would say it is not. */
  adopted: string[];
  /** Asked to stop, and the stop answered true. */
  stopped: string[];
  /** Asked to stop, and it failed or threw: still in systemd, retried on the
   *  next boot. */
  failed: string[];
}

/** A scope nobody can describe: a comm that came back empty, or a level of the
 *  tree that could not be read. Unknown is not empty, and here it is all that
 *  keeps a scope. */
function unreadable(fact: ScopeFact): boolean {
  if (fact.comms.length !== fact.procs.length) return true;
  if (fact.nested === null) return true;
  return fact.comms.some((c) => c === "") || (fact.nested ?? []).some((n) => n.comm === "");
}

/** What an adopted scope owes the log: the unit, the server it lost, and why it
 *  was kept. */
function adoptLine(unit: string, owner: number, why: string): string {
  return `🧹 scopes: adopting ${unit} — server ${owner} is gone and ${why}`;
}

/** And what a stopped one owes: the unit, the server, and everything the stop
 *  kills, its own cgroup and every level below. */
function orphanStopLine(unit: string, owner: number, fact: ScopeFact): string {
  const inScope = [
    ...fact.procs.map((pid, i) => `${pid}:${fact.comms[i]}`),
    ...(fact.nested ?? []).map((n) => `${n.pid}:${n.comm}`),
  ].join(" ");
  return `🧹 scopes: stopping ${unit} — server ${owner} is gone and no live worker answers for it; in it: ${inScope || "none"}`;
}

/** Why a scope is kept, read from what its processes say: a live worker's name,
 *  an engine's private server, or a directory a live row works in. `"doubt"`
 *  when one of them could not be read from a process that is still there,
 *  which keeps the scope too. A pid that has left `/proc` between the cgroup
 *  read and this one says nothing and is skipped: gone is not doubt. Null when
 *  nothing in it says anybody is working, so it is a leftover. */
type Kept = { why: string; name?: string } | "doubt" | null;

function keepReason(
  pids: readonly number[],
  r: {
    ownerOf: (pid: number) => OwnerRead;
    serves: (pid: number) => boolean;
    cwdOf: (pid: number) => string | null;
    alive: (pid: number) => boolean;
    dirs: readonly { dir: string; name?: string }[];
    live: LiveTurns;
  },
): Kept {
  let doubt = false;
  for (const pid of pids) {
    const owner = r.ownerOf(pid);
    if (owner.state === "unreadable") {
      // A pid that went away between the reads is not hiding anything.
      if (!r.alive(pid)) continue;
      doubt = true;
      continue;
    }
    if (owner.state === "owner" && r.live.names.has(owner.name)) {
      return { why: `worker ${owner.name} is still running in it`, name: owner.name };
    }
    const cwd = r.cwdOf(pid);
    if (r.serves(pid)) {
      // The serve's own directory is how its row is known when its environ
      // named nobody (the first boot after an upgrade).
      const served = cwd === null ? undefined : r.dirs.find((d) => within(d.dir, cwd));
      return { why: "an engine's private server is running in it", ...(served?.name ? { name: served.name } : {}) };
    }
    if (cwd === null) {
      if (!r.alive(pid)) continue;
      doubt = true;
      continue;
    }
    const dir = r.dirs.find((d) => within(d.dir, cwd));
    if (dir) return { why: `a turn working in ${dir.dir} is still running in it`, ...(dir.name ? { name: dir.name } : {}) };
  }
  return doubt ? "doubt" : null;
}

/**
 * The boot pass: child scopes whose server is gone. Adopt the ones a live
 * worker is still running in, stop the rest. Nothing is stopped on a list, a
 * fact, an owner, a cwd or a registry that could not be read, and a failed stop
 * is reported as failed rather than counted as a stop.
 */
export function adoptOrphanScopes(deps: OrphanScopesDeps = {}): OrphanScopes {
  const out: OrphanScopes = { adopted: [], stopped: [], failed: [] };
  // The same switch the age sweep honours: off means systemd is not asked
  // anything at all.
  if (!(deps.on ?? scopesFor().on)) return out;
  const units = (deps.list ?? realList)();
  if (!units) return out;
  const live = (deps.live ?? (() => null))();
  if (!live) return out;
  const alive = deps.alive ?? pidAlive;
  const ownerOf = deps.ownerOf ?? realOwnerOf;
  const serves = deps.serves ?? realServes;
  const cwdOf = deps.cwdOf ?? realCwdOf;
  const stop = deps.stop ?? realStopUnit;
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const selfPid = deps.selfPid ?? process.pid;
  const dirs = liveDirs(live);
  for (const unit of units) {
    if (!unit.startsWith(SCOPE_PREFIX)) continue;
    const owner = childScopeOwner(unit);
    // A live server is not this pass's business, and neither is this one.
    if (owner === null || owner === selfPid || alive(owner)) continue;
    const fact = (deps.fact ?? realFact)(unit);
    if (!fact || fact.unit !== unit) {
      // A scope nobody could describe is kept for this sweep: the age sweep
      // must not stop what this pass could not read.
      log(adoptLine(unit, owner, "nothing in it could be read, so it is kept"));
      out.adopted.push(unit);
      continue;
    }
    const held = heldPids(fact);
    if (held === null) {
      log(adoptLine(unit, owner, "nothing in it could be read, so it is kept"));
      out.adopted.push(unit);
      continue;
    }
    if (held.includes(selfPid)) continue;
    const kept = keepReason(held, { ownerOf, serves, cwdOf, alive, dirs, live });
    if (kept) {
      // Doubt is a reason to keep the scope, and the log says which it was.
      log(adoptLine(unit, owner, kept === "doubt" ? "nothing in it could be read, so it is kept" : kept.why));
      out.adopted.push(unit);
      // An adopted unit answers to the window it was found working for: that
      // window's end is what stops it, and this process never noted the launch.
      if (kept !== "doubt" && kept.name) noteRunScope(kept.name, unit);
      continue;
    }
    if (unreadable(fact)) {
      // A comm or a level of the tree that came back empty: kept and recorded,
      // so the sweep that follows does not read an unreadable scope as empty.
      log(adoptLine(unit, owner, "nothing in it could be read, so it is kept"));
      out.adopted.push(unit);
      continue;
    }
    log(orphanStopLine(unit, owner, fact));
    let stopped = true;
    try { stopped = stop(unit) !== false; } catch { stopped = false; }
    log(outcomeLine(unit, stopped));
    (stopped ? out.stopped : out.failed).push(unit);
  }
  return out;
}

/** The units among `units` that still answer yes to the boot pass's own
 *  `keepReason` question, asked again with the registry as it is now. The keep
 *  set is not a fact frozen at boot: a turn that ended since then leaves its
 *  scope to the age sweep, and one still working keeps it. An unreadable
 *  registry keeps every unit; one that has left systemd keeps nothing. */
export function stillAdopted(
  units: Iterable<string>,
  deps: {
    live: () => LiveTurns | null;
    fact?: (unit: string) => ScopeFact | null;
    alive?: (pid: number) => boolean;
    ownerOf?: (pid: number) => OwnerRead;
    serves?: (pid: number) => boolean;
    cwdOf?: (pid: number) => string | null;
    selfPid?: number;
  },
): Set<string> {
  const out = new Set<string>();
  const all = [...units];
  if (!all.length) return out;
  const live = deps.live();
  if (!live) {
    for (const u of all) out.add(u);
    return out;
  }
  const factOf = deps.fact ?? realFact;
  const alive = deps.alive ?? pidAlive;
  const ownerOf = deps.ownerOf ?? realOwnerOf;
  const serves = deps.serves ?? realServes;
  const cwdOf = deps.cwdOf ?? realCwdOf;
  const selfPid = deps.selfPid ?? process.pid;
  const dirs = liveDirs(live);
  for (const unit of all) {
    const fact = factOf(unit);
    // Gone from systemd: nothing left to keep, and nothing for the sweep either.
    if (!fact || fact.unit !== unit) continue;
    const held = heldPids(fact);
    if (held === null || held.includes(selfPid) || unreadable(fact)) {
      out.add(unit);
      continue;
    }
    if (keepReason(held, { ownerOf, serves, cwdOf, alive, dirs, live })) out.add(unit);
  }
  return out;
}

/** What one boot pass did, and whether it needs another tick. */
export interface BootSetup {
  adopted: string[];
  stopped: string[];
  failed: string[];
  /** True when the age sweep was started, handed the adopted units. */
  swept: boolean;
  /** True when no verdict was reached: no sweep this tick, try again on the
   *  next one. Never a reason to leave the sweep off for the process. */
  retry: boolean;
}

/**
 * The policy of the boot pass, as three decisions in one place: adopt and stop
 * orphan scopes, hand what was adopted to the age sweep as its keep set, and
 * sweep only when the roster could be read. A roster that could not be read,
 * or a pass that threw, starts no sweep and asks for the next tick instead.
 */
export function bootScopes(d: {
  /** The app's own copy (`sweepsAppScopes()`). */
  appCopy: boolean;
  /** The registry read, or null when it could not be read. */
  live: () => LiveTurns | null;
  adopt?: (deps: OrphanScopesDeps) => OrphanScopes;
  sweep?: (deps: ReapScopesDeps) => void;
  /** How the sweep's keep set is asked for again; `stillAdopted` is the real
   *  answer, and a test supplies its own so it never reads `/proc`. */
  keepNow?: (units: ReadonlySet<string>) => ReadonlySet<string>;
  /** The reads the default keep set makes, for a test that has no `/proc` or
   *  systemd to read. */
  keepDeps?: Omit<Parameters<typeof stillAdopted>[1], "live">;
  log?: (line: string) => void;
  error?: (line: string) => void;
}): BootSetup {
  const idle: BootSetup = { adopted: [], stopped: [], failed: [], swept: false, retry: false };
  if (!d.appCopy) return idle;
  const log = d.log ?? ((line: string) => { console.log(line); });
  const error = d.error ?? ((line: string) => { console.error(line); });
  let live: LiveTurns | null;
  try {
    live = d.live();
  } catch (e) {
    error(`[agentglass] scope adoption: the registry could not be read: ${String(e)}`);
    return { ...idle, retry: true };
  }
  if (!live) {
    error("[agentglass] scope adoption: the registry could not be read");
    return { ...idle, retry: true };
  }
  const adopted = new Set<string>();
  let orphans: OrphanScopes;
  try {
    orphans = (d.adopt ?? adoptOrphanScopes)({ live: () => live, log });
  } catch (e) {
    error(`[agentglass] scope adoption: ${String(e)}`);
    return { ...idle, retry: true };
  }
  for (const unit of orphans.adopted) adopted.add(unit);
  if (orphans.adopted.length || orphans.stopped.length || orphans.failed.length) {
    const failed = orphans.failed.length ? `, ${orphans.failed.length} did not stop` : "";
    log(`🧹 scopes: ${orphans.adopted.length} adopted from a dead server, ${orphans.stopped.length} stopped${failed}`);
  }
  (d.sweep ?? ((deps: ReapScopesDeps) => startScopeReaper(deps)))({
    keep: () => d.keepNow ? d.keepNow(adopted) : stillAdopted(adopted, { live: d.live, ...d.keepDeps }),
  });
  return { adopted: orphans.adopted, stopped: orphans.stopped, failed: orphans.failed, swept: true, retry: false };
}

/** The desktop app's own copy is the only one that manages app scopes: one
 *  belongs to that app, and a server somebody started by hand (or a test) has
 *  no business stopping another copy's children. */
export function sweepsAppScopes(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTGLASS_DIE_WITH_PARENT === "1";
}

/** The sweep on a clock, for index.ts. Never called from a test.
 *  Cost, every ten minutes: one `systemctl show` per scope this app owns or the
 *  app's own, then one `cgroup.procs` read per cgroup in it and one
 *  `/proc/<pid>/comm` per process in it. `memoryWatch` pays the same walk above
 *  80 % pressure, because the row it prints is the scope's whole tree. */
export function startScopeReaper(deps: ReapScopesDeps = {}): void {
  if (!sweepsAppScopes()) return;
  if (!scopesFor().on) return;
  const run = (): void => {
    try {
      reapStaleScopes(deps);
    } catch (e) {
      console.error(`[agentglass] scope reaper: ${String(e)}`);
    }
  };
  run();
  setIntervalAs("scopes sweep", run, SWEEP_EVERY_MS).unref?.();
}

// --------------------------------------------------------------- memory ----

export interface ScopeMemory { unit: string; rss: number; procs: number }
export interface MemoryWatch {
  /** Used share of RAM, 0..1. */
  pressure: number;
  memTotal: number;
  memAvailable: number;
  /** True above `MEMORY_PRESSURE`; below it `scopes` is empty on purpose. */
  over: boolean;
  /** Top RSS per scope, biggest first. Only meaningful when `over`. */
  scopes: ScopeMemory[];
}

/** MemAvailable over MemTotal, the kernel's own estimate — MemFree counts cache
 *  as used and reads alarming on a machine that is fine. */
export function memoryPressure(meminfo: string): { memTotal: number; memAvailable: number; pressure: number } {
  const total = meminfoBytes(meminfo, "MemTotal");
  const available = meminfoBytes(meminfo, "MemAvailable");
  if (total <= 0) return { memTotal: 0, memAvailable: 0, pressure: 0 };
  return { memTotal: total, memAvailable: available, pressure: Math.min(1, Math.max(0, 1 - available / total)) };
}

function readMeminfo(): string {
  try { return readFileSync("/proc/meminfo", "utf8"); } catch { return ""; }
}

/** Resident bytes of one process, from the same `/proc/<pid>/stat` walk. */
function rssOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const pages = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[21]);
    return Number.isFinite(pages) ? Math.max(0, pages) * 4096 : 0;
  } catch { return 0; }
}

export interface MemoryWatchDeps {
  meminfo?: () => string;
  list?: () => string[] | null;
  fact?: (unit: string) => ScopeFact | null;
  rss?: (pid: number) => number;
  top?: number;
}

/**
 * mem-watch, as a read: top RSS per scope, computed only above 80 % pressure.
 * The gate is the point — walking every cgroup on a healthy machine answers a
 * question nobody is asking and costs a /proc read per process.
 */
export function memoryWatch(deps: MemoryWatchDeps = {}): MemoryWatch {
  const m = memoryPressure((deps.meminfo ?? readMeminfo)());
  const empty: MemoryWatch = { ...m, over: false, scopes: [] };
  if (m.pressure <= MEMORY_PRESSURE) return empty;
  const units = (deps.list ?? realList)();
  if (!units) return { ...m, over: true, scopes: [] };
  const factOf = deps.fact ?? realFact;
  const rss = deps.rss ?? rssOf;
  const rows: ScopeMemory[] = [];
  for (const unit of units) {
    if (!MEMORY_SCOPE_PREFIXES.some((p) => unit.startsWith(p))) continue;
    const fact = factOf(unit);
    if (!fact) continue;
    // The scope's payload usually lives one level down, so a row that counted
    // only the own cgroup would show the scope eating the machine as nothing.
    const pids = heldPids(fact);
    if (pids === null) continue;
    let bytes = 0;
    for (const pid of pids) bytes += rss(pid);
    rows.push({ unit, rss: bytes, procs: pids.length });
  }
  rows.sort((a, b) => b.rss - a.rss);
  return { ...m, over: true, scopes: rows.slice(0, deps.top ?? 10) };
}
