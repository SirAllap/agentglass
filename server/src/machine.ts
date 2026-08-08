// What this machine is actually doing: which ports are open, what is eating the
// CPU and the RAM, and where the disk went.
//
// Every one of these questions has a perfectly good command-line answer — `ss`,
// `top`, `du` — and asking any of them means leaving the app, finding a shell,
// and then translating a pid back into "which of my six worktrees is that". The
// translation is the part worth automating: a port is only interesting once you
// know it is *your* dev server in *that* checkout, and a 700 MB process is only
// actionable once you know which branch it belongs to.
//
// The cwd is what does the translating. `/proc/<pid>/cwd` is a symlink the
// kernel keeps for every process, and for a process we started it points at the
// worktree it was started in — so the answer to "whose is this?" is one readlink
// away, with no registry of pids to keep in sync with reality.
//
// Deliberately read-only except for one thing, and that one thing (`kill`) will
// only ever touch a process this user owns.

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, statfsSync } from "node:fs";

/** One listening TCP socket. */
export interface PortEntry {
  port: number;
  /** The address it is bound to, as `ss` reports it: 0.0.0.0, 127.0.0.1, ::, … */
  addr: string;
  /** The process's short name, when we are allowed to see it. */
  proc: string | null;
  pid: number | null;
  /** Where that process was started — the worktree, nine times out of ten. */
  cwd: string | null;
  /**
   * Whether this is one of ours. True when the process is owned by the user
   * running the server, which is also exactly when we may read its cwd and
   * exactly when killing it is our business.
   */
  mine: boolean;
  /** Seconds since it started, or null when /proc would not say. */
  ageSec: number | null;
  /** Its ancestry runs through an agent's tool-call shell — a fact about who
   *  started it, not a verdict about whether it should still be running. */
  fromAgent: boolean;
  /** Its working directory is gone: the checkout it was serving was deleted
   *  underneath it. */
  cwdGone: boolean;
  /**
   * What started it, nearest first — `bun ← bash ← agentglass-server`.
   *
   * A port and a pid say what is listening. They do not say why, and "why" is
   * the question actually being asked of this panel: a server nobody remembers
   * starting is the one you are here to find, and whether it is safe to stop it
   * depends entirely on what is holding it. A `bun` under a login shell is a
   * dev server somebody left running; the same `bun` under this app's own
   * sidecar came out of an agent's terminal and inherited that terminal's
   * environment — which is how one of these ended up on 0.0.0.0 carrying a
   * token nobody meant to hand out.
   *
   * Empty for other users' processes, which /proc will not describe, and for
   * the ones whose parents have already exited.
   */
  ancestry: Forebear[];
  /**
   * It is bound to every interface, not to loopback.
   *
   * Stated rather than left for the reader to spot in `addr`, because it is the
   * one fact on the row with a consequence: everything else describes a process
   * on this machine, and this says the machine is not where it ends.
   */
  publicBind: boolean;
  /**
   * The executable behind it has been deleted or replaced.
   *
   * `/proc/<pid>/exe` still resolves — the kernel holds the inode open — but the
   * path it names is gone, which it reports by appending " (deleted)". It means
   * the running code is not the code on disk: a rebuild happened underneath it,
   * or an upgrade replaced the binary. Neither is an error, and both explain a
   * process that is behaving like a version you no longer have.
   *
   * Ours only. Null where /proc would not say.
   */
  exeGone: boolean;
}

/** One rung of a process's ancestry. */
export interface Forebear {
  pid: number;
  /** The short name — `bash`, not sixty characters of flags. Rows are narrow
   *  and the chain is read at a glance or not at all. */
  name: string;
}

export interface PortsReport {
  ports: PortEntry[];
  mine: number;
  external: number;
  /** Set when `ss` is missing or refused, so the panel can say why rather than
   *  showing an empty list that looks like "no ports are open". */
  error?: string;
}

/** One process worth showing. */
export interface ProcEntry {
  pid: number;
  /** The kernel's short name (`/proc/<pid>/stat`'s comm) — "node", "claude". */
  comm: string;
  /** Enough of the command line to tell two `node`s apart. */
  cmd: string;
  /** Percent of one core, averaged over the gap since the last sample. Null on
   *  the very first sample, because a rate needs two readings and inventing one
   *  from a single total would report a process's whole lifetime as "now". */
  cpu: number | null;
  /** Resident set size in bytes. */
  rss: number;
  cwd: string | null;
  /** A descendant of this server — a shell we opened, an agent it started, and
   *  everything those went on to spawn. The one distinction the panel is really
   *  about: "is this me, or is it the rest of the machine?" */
  ours: boolean;
  /** Parent, so the client can build the tree rather than a flat list. */
  ppid: number;
}

export interface ResourceReport {
  procs: ProcEntry[];
  totalCpu: number | null;
  totalRss: number;
  /** The machine as a whole, so "ours" has something to be a share OF. */
  machine: MachineTotals;
  /** The same two numbers for our own subtree. The difference between these and
   *  the totals is "everything else on this machine", which the panel shows as
   *  one collapsed line rather than four hundred rows of browser tab. */
  oursCpu: number | null;
  oursRss: number;
  /** How many of this user's processes were seen, before the list was cut to
   *  the biggest. A panel that shows 40 of 300 should say so. */
  seen: number;
  /** False on the first call after a quiet period: CPU is a rate and there is
   *  nothing to compare against yet. */
  rated: boolean;
}

export interface SpaceDir {
  path: string;
  name: string;
  bytes: number;
  /** Rebuildable from the repository and a package manager — node_modules,
   *  dist, target. Named rather than deleted: see `spaceFor`. */
  reclaimable: boolean;
}

export interface SpaceReport {
  root: string;
  bytes: number;
  freeable: number;
  dirs: SpaceDir[];
  error?: string;
}

// USER_HZ. It is 100 on every Linux this app runs on — the constant is compiled
// into the kernel's ABI for /proc, not read from anywhere at runtime.
const HZ = 100;
const PAGE = 4096;

/** The uid we are, so "mine" is a fact rather than a guess. Cached: it cannot
 *  change while the process lives. */
const MY_UID = typeof process.getuid === "function" ? process.getuid() : -1;

// ---------------------------------------------------------------- ports ----

/**
 * `ss -ltnp`, parsed.
 *
 * `-l` listening, `-t` tcp, `-n` numeric (no DNS round trip per socket), `-p`
 * the owning process. The process column is only filled in for sockets this
 * user owns; everything else comes back bare, which is why the panel has an
 * "external" section rather than pretending it knows.
 */
export function listPorts(): PortsReport {
  let out: string;
  try {
    const r = Bun.spawnSync(["ss", "-ltnpH"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    if (!r.success && !r.stdout.length) {
      return { ports: [], mine: 0, external: 0, error: new TextDecoder().decode(r.stderr).trim() || "ss failed" };
    }
    out = new TextDecoder().decode(r.stdout);
  } catch {
    return { ports: [], mine: 0, external: 0, error: "ss is not installed — it ships with iproute2" };
  }

  return parsePorts(out);
}

/**
 * `ss`'s output, turned into rows.
 *
 * Split out from the spawn so it can be tested against real output — every bug
 * this function can have is a parsing bug, and none of them are reachable if
 * the only way to exercise it is to have the right sockets open on the machine
 * running the tests.
 */
export function parsePorts(out: string): PortsReport {
  const seen = new Set<string>();
  const ports: PortEntry[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    // An `ss` without -H prints a header; skip it rather than parsing "State"
    // as a socket. (Older iproute2 has no -H at all.)
    if (cols[0] === "State" || cols[0] === "Netid") continue;
    const local = cols[3];
    if (!local) continue;
    const at = local.lastIndexOf(":");
    if (at < 0) continue;
    const port = Number(local.slice(at + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    // `127.0.0.53%lo` — the interface suffix is noise here. `[::]` keeps its
    // brackets in ss's output and loses them in ours; the panel prints it.
    const addr = local.slice(0, at).replace(/%.*$/, "").replace(/^\[|\]$/g, "");

    const who = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = who ? Number(who[2]) : null;
    const proc = who ? who[1]! : null;
    const mine = pid != null && ownedByMe(pid);

    const key = `${addr}:${port}:${pid ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only for processes we own: /proc says nothing useful about anybody
    // else's, and asking is how a ports panel turns into a machine audit.
    const cwd = mine && pid != null ? cwdOf(pid) : null;
    ports.push({
      port, addr, proc, pid, cwd, mine,
      ageSec: mine && pid != null ? ageSecOf(pid) : null,
      fromAgent: mine && pid != null ? startedByAgent(pid) : false,
      // Ours only, for the same reason as `cwd` above: /proc says nothing
      // useful about another user's tree, and asking anyway is how a ports
      // panel turns into a machine audit.
      ancestry: mine && pid != null ? ancestryOf(pid) : [],
      publicBind: isPublicBind(addr),
      exeGone: mine && pid != null ? exeDeleted(pid) : false,
      // A null cwd is unknown, not gone — an unreadable link and a deleted
      // directory are different facts and only one of them is a verdict.
      cwdGone: cwd != null && !existsSync(cwd),
    });
  }

  // Ours first and by port, then everything else by port: the list is read
  // top-down looking for something you started, never for port 53.
  ports.sort((a, b) => Number(b.mine) - Number(a.mine) || a.port - b.port);
  const mine = ports.filter((p) => p.mine).length;
  return { ports, mine, external: ports.length - mine };
}

/**
 * Stop a process we started.
 *
 * SIGTERM, never SIGKILL: this is aimed at dev servers, and a dev server that
 * is given the chance to shut down cleanly puts its port back and does not leave
 * a lockfile behind. The ownership check is the whole security story — a pid
 * belonging to another user is refused before `kill` is ever called, so this
 * cannot be turned into "signal anything on the box".
 */
export function killPort(pidIn: unknown): { ok: boolean; error?: string; detail?: string } {
  const pid = Number(pidIn);
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "not a process id" };
  if (pid === process.pid) return { ok: false, error: "that is this server — stop it from the terminal" };
  if (!ownedByMe(pid)) return { ok: false, error: "that process belongs to another user" };
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true, detail: `Asked ${pid} to stop` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ------------------------------------------------------------ resources ----

/**
 * The previous CPU sample, so the next one can be a rate.
 *
 * /proc reports *totals* — ticks since the process started. A single reading
 * cannot say whether those ticks were spent in the last second or last week, so
 * the first call after a quiet period reports no CPU at all rather than a number
 * that means "this process's whole life, averaged". Kept per pid and stamped, so
 * a pid that got recycled between samples cannot inherit a stranger's ticks.
 */
const lastTicks = new Map<number, { ticks: number; at: number; start: number }>();
/**
 * What the whole machine is doing, not just our share of it.
 *
 * The panel could say "our 67 processes are using 4.26 GB" and leave you with
 * no idea whether that was most of the machine or a rounding error. These are
 * the numbers a system monitor opens with, so the app does not have to be the
 * reason you go and open one.
 *
 * Every field is a file read. Nothing here shells out, because this rides the
 * same poll as the process list and a spawn per refresh for numbers sitting in
 * /proc would be a spawn for nothing.
 */
export interface MachineTotals {
  /** Busy percent across all cores, 0..100. Null on the first sample — a rate
   *  needs two readings, the same reason a process's CPU starts null. */
  cpu: number | null;
  cores: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  /** The hottest zone the kernel exposes, in °C, or null where it exposes
   *  none — a VM and a laptop are different machines about this. */
  tempC: number | null;
  /** One-minute load. Reported beside CPU rather than instead of it: they
   *  disagree usefully, since load counts waiting for disk and CPU does not. */
  load1: number;
  diskFree: number;
  diskTotal: number;
}

/** The previous /proc/stat reading. Busy percent is a difference between two
 *  samples; a single one only says what the machine has done since boot. */
let cpuPrev: { total: number; idle: number; at: number } | null = null;

function cpuTotals(): { cpu: number | null; cores: number } {
  let cores = 1;
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    // Field order is fixed: user nice system idle iowait irq softirq steal…
    // idle + iowait is the not-working half; everything else is work.
    const first = stat.split("\n", 1)[0]!.trim().split(/\s+/).slice(1).map(Number);
    cores = stat.split("\n").filter((l) => /^cpu\d/.test(l)).length || 1;
    const total = first.reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0);
    const idle = (first[3] ?? 0) + (first[4] ?? 0);
    const now = Date.now();
    const prev = cpuPrev;
    cpuPrev = { total, idle, at: now };
    if (!prev || now - prev.at > SAMPLE_STALE_MS) return { cpu: null, cores };
    const dt = total - prev.total;
    const di = idle - prev.idle;
    // A counter that went backwards means the machine suspended or the file
    // was read mid-update; a negative percentage is worse than no number.
    if (dt <= 0 || di < 0) return { cpu: null, cores };
    return { cpu: Math.min(100, Math.max(0, ((dt - di) / dt) * 100)), cores };
  } catch { return { cpu: null, cores }; }
}

/** °C from the hottest thermal zone. Kernels report millidegrees, and some
 *  expose zones that read zero or nonsense — those are dropped rather than
 *  averaged in, because one bogus zone would drag a real reading down. */
function hottestC(): number | null {
  try {
    let best: number | null = null;
    for (const zone of readdirSync("/sys/class/thermal")) {
      if (!zone.startsWith("thermal_zone")) continue;
      const raw = Number(readFileSync(`/sys/class/thermal/${zone}/temp`, "utf8").trim());
      if (!Number.isFinite(raw) || raw <= 0) continue;
      const c = raw > 1000 ? raw / 1000 : raw;
      if (c > 0 && c < 150 && (best === null || c > best)) best = c;
    }
    return best;
  } catch { return null; }
}

export function machineTotals(): MachineTotals {
  const { cpu, cores } = cpuTotals();
  let memTotal = 0, memAvail = 0, swapTotal = 0, swapFree = 0;
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+) kB/);
      if (!m) continue;
      const v = Number(m[2]) * 1024;
      if (m[1] === "MemTotal") memTotal = v;
      // MemAvailable, not MemFree: the kernel's own estimate of what a new
      // process could actually get. MemFree counts cache as used and reads
      // alarmingly low on a machine that is behaving perfectly.
      else if (m[1] === "MemAvailable") memAvail = v;
      else if (m[1] === "SwapTotal") swapTotal = v;
      else if (m[1] === "SwapFree") swapFree = v;
    }
  } catch { /* not Linux, or /proc is not mounted */ }

  let load1 = 0;
  try { load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) || 0; } catch { /* absent */ }

  let diskFree = 0, diskTotal = 0;
  try {
    const fs = statfsSync("/");
    diskTotal = Number(fs.blocks) * Number(fs.bsize);
    // bavail, not bfree: bfree includes the blocks reserved for root, which a
    // user cannot have and should not be shown as free.
    diskFree = Number(fs.bavail) * Number(fs.bsize);
  } catch { /* older runtimes have no statfs */ }

  return {
    cpu, cores,
    memUsed: Math.max(0, memTotal - memAvail), memTotal,
    swapUsed: Math.max(0, swapTotal - swapFree), swapTotal,
    tempC: hottestC(), load1, diskFree, diskTotal,
  };
}

/** Older than this and the previous sample is not a comparison, it is history. */
const SAMPLE_STALE_MS = 30_000;

/**
 * Every process this user owns, with what it is costing.
 *
 * One read of `/proc/<pid>/stat` per process answers name, parent, CPU and RSS
 * together — the alternative (`status` for VmRSS) doubles the syscalls for a
 * number that is already in `stat`, in pages.
 */
export function listResources(limit = 40): ResourceReport {
  const now = Date.now();
  const rows: ProcEntry[] = [];
  let pids: string[];
  try { pids = readdirSync("/proc"); } catch { return { procs: [], totalCpu: null, totalRss: 0, oursCpu: null, oursRss: 0, seen: 0, rated: false, machine: machineTotals() }; }

  let rated = false;
  for (const name of pids) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue; // not a pid
    const pid = Number(name);
    if (!ownedByMe(pid)) continue;

    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; } // exited mid-walk

    // comm is parenthesised and may itself contain spaces and parens ("(sd-pam)"),
    // so the fields after it start at the LAST ")" — splitting the whole line on
    // whitespace is the classic way to misread every field from here on.
    const close = stat.lastIndexOf(")");
    const open = stat.indexOf("(");
    if (close < 0 || open < 0) continue;
    const comm = stat.slice(open + 1, close);
    const f = stat.slice(close + 2).split(" ");
    // Fields, 1-indexed from `state`: ppid 2, utime 12, stime 13, starttime 20,
    // rss 22.
    const ppid = Number(f[1] ?? 0);
    const utime = Number(f[11] ?? 0), stime = Number(f[12] ?? 0);
    const start = Number(f[19] ?? 0);
    const rss = Number(f[21] ?? 0) * PAGE;
    const ticks = utime + stime;

    let cpu: number | null = null;
    const prev = lastTicks.get(pid);
    // `start` guards pid reuse: same number, different process, and its ticks
    // would look like a burst of activity that never happened.
    if (prev && prev.start === start && now - prev.at < SAMPLE_STALE_MS && now > prev.at) {
      cpu = ((ticks - prev.ticks) / HZ) / ((now - prev.at) / 1000) * 100;
      if (cpu < 0) cpu = 0; // clock skew, or a counter we misread — not a negative
      rated = true;
    }
    lastTicks.set(pid, { ticks, at: now, start });

    rows.push({ pid, ppid, comm, cmd: "", cpu, rss, cwd: null, ours: false });
  }

  // Forget pids that are gone, so a long-running server does not accumulate a
  // map entry per process the machine has ever run.
  if (lastTicks.size > 4000) {
    for (const [pid, s] of lastTicks) if (now - s.at > SAMPLE_STALE_MS) lastTicks.delete(pid);
  }

  markOurs(rows);

  const seen = rows.length;
  const totalRss = rows.reduce((n, r) => n + r.rss, 0);
  const totalCpu = rated ? rows.reduce((n, r) => n + (r.cpu ?? 0), 0) : null;
  const ours = rows.filter((r) => r.ours);
  const oursRss = ours.reduce((n, r) => n + r.rss, 0);
  const oursCpu = rated ? ours.reduce((n, r) => n + (r.cpu ?? 0), 0) : null;

  // Everything of ours, however small — a 6 MB shell you opened is part of the
  // answer to "what is agentglass running" in a way that a 6 MB system daemon
  // is not. The rest of the machine is cut to the biggest, because that list is
  // only ever read looking for the thing at the top of it.
  rows.sort((a, b) => b.rss - a.rss);
  const kept = [...ours, ...rows.filter((r) => !r.ours).slice(0, Math.max(1, limit))];
  // Only the kept rows pay for the expensive per-process reads: a cmdline and a
  // cwd are two more syscalls each, and nobody scrolls to the four-hundredth
  // process to read its arguments.
  for (const r of kept) {
    r.cwd = cwdOf(r.pid);
    r.cmd = cmdlineOf(r.pid);
  }
  kept.sort((a, b) => Number(b.ours) - Number(a.ours) || b.rss - a.rss);
  return { procs: kept, totalCpu, totalRss, oursCpu, oursRss, seen, rated, machine: machineTotals() };
}

/**
 * Mark everything descended from this server.
 *
 * Walked from the roots down rather than by climbing from each process: one
 * pass over a children map settles three hundred processes, where climbing is a
 * walk up the tree per process and re-answers the same question about `systemd`
 * three hundred times.
 *
 * The server itself is a root, which covers every shell it opened and
 * everything those shells went on to run. A tmux server is a root too when we
 * started it — panes are children of the tmux server, not of us, so without this
 * every agent running in tmux would count as "the rest of the machine", which is
 * precisely backwards.
 */
function markOurs(rows: ProcEntry[]): void {
  const kids = new Map<number, ProcEntry[]>();
  for (const r of rows) {
    const arr = kids.get(r.ppid) ?? [];
    arr.push(r);
    kids.set(r.ppid, arr);
  }
  // A tmux server re-parents itself to init, so it cannot be found by descent —
  // it is picked out by name, and only among this user's processes.
  const roots = rows.filter((r) => r.pid === process.pid || r.comm === "tmux" || r.comm.startsWith("tmux:"));
  const queue = [...roots];
  const seen = new Set<number>();
  while (queue.length) {
    const r = queue.pop()!;
    if (seen.has(r.pid)) continue; // a cycle cannot happen, but a wrong ppid can
    seen.add(r.pid);
    r.ours = true;
    for (const k of kids.get(r.pid) ?? []) queue.push(k);
  }
}

// ---------------------------------------------------------------- space ----

/** Rebuildable by a package manager or a compiler — the directories worth
 *  naming when the disk is full, because losing them costs a command. */
const RECLAIMABLE = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".parcel-cache",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv",
  "coverage", ".gradle", ".cache", "vendor", "dist-app", "staging",
]);

/**
 * Where a checkout's disk went, one level down.
 *
 * `du` and nothing else: a real recursive walk in JavaScript over a
 * node_modules is thousands of syscalls on the event loop, and `du` is a C
 * program written for exactly this. One level deep because that is the level
 * decisions are made at — "node_modules is 900 MB" is actionable, "this .ts
 * file is 4 KB" is not.
 *
 * Reports only. Nothing here deletes anything: a button that removes a
 * directory because it *looks* rebuildable is one mislabelled entry away from
 * taking someone's work, and the shell is two keystrokes away.
 */
export function spaceFor(rootIn: unknown, dir = true): SpaceReport {
  const root = typeof rootIn === "string" ? rootIn : "";
  const empty: SpaceReport = { root, bytes: 0, freeable: 0, dirs: [] };
  if (!root) return { ...empty, error: "no directory given" };
  try { if (!statSync(root).isDirectory()) return { ...empty, error: "not a directory" }; }
  catch { return { ...empty, error: "no such directory" }; }

  // --max-depth=1 gives the children AND the total in one pass, so the panel's
  // headline and its breakdown can never disagree with each other. No `-s`
  // alongside it: `du` refuses the pair outright ("summarizing conflicts with
  // --max-depth"), which is a warning on stderr and an empty report.
  const r = Bun.spawnSync(["du", "-b", "--max-depth=1", root], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const text = new TextDecoder().decode(r.stdout);
  if (!text.trim()) return { ...empty, error: new TextDecoder().decode(r.stderr).trim() || "du returned nothing" };

  const dirs: SpaceDir[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+)\t(.+)$/);
    if (!m) continue;
    const bytes = Number(m[1]);
    const path = m[2]!;
    if (path === root) { total = bytes; continue; }
    const name = path.slice(root.length + 1);
    if (!name || name.includes("/")) continue; // deeper than one level
    dirs.push({ path, name, bytes, reclaimable: RECLAIMABLE.has(name) });
  }
  dirs.sort((a, b) => b.bytes - a.bytes);
  void dir;
  return { root, bytes: total, freeable: dirs.filter((d) => d.reclaimable).reduce((n, d) => n + d.bytes, 0), dirs };
}

// --------------------------------------------------------------- shared ----

/** Is this process ours? The one check that decides whether we may read its
 *  working directory and whether we may signal it. */
export function ownedByMe(pid: number): boolean {
  if (MY_UID < 0) return false;
  try { return statSync(`/proc/${pid}`).uid === MY_UID; } catch { return false; }
}

/** Where a process was started. For anything we launched this is the worktree,
 *  which is the only reason any of this is more useful than `top`. */
export function cwdOf(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

/**
 * How long a process has been up, in seconds.
 *
 * Field 22 of /proc/<pid>/stat is its start time in clock ticks since boot, so
 * the age is uptime minus that. Read rather than shelled out to `ps` because
 * this runs per listening socket on a poll, and a spawn per row for a number
 * already sitting in a file is a spawn for nothing.
 *
 * The command name in field 2 is parenthesised and may itself contain spaces
 * or brackets, so the fields are counted from the LAST `)` — splitting the
 * whole line on whitespace is the classic way to read this file wrong.
 */
export function ageSecOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // stat[22] is the 22nd field overall; fields 1 and 2 are before the split.
    const ticks = Number(rest[19]);
    if (!Number.isFinite(ticks)) return null;
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(uptime)) return null;
    // 100 Hz is the value Linux has shipped for every architecture this runs
    // on; there is no syscall to read it from a process that is not us.
    const age = Math.round(uptime - ticks / 100);
    return age >= 0 ? age : null;
  } catch { return null; }
}

/** The mark a coding agent's tool call leaves on the shell it runs commands in.
 *  Matched on the path rather than the word "claude", which appears in half the
 *  command lines on a machine like this one. */
const AGENT_SHELL = /\.claude\/shell-snapshots\//;

/**
 * Did an agent's tool call start this?
 *
 * Walks up the parents rather than looking only at the immediate one: a server
 * launched as `setsid env … bun run …` sits at least one wrapper below the
 * shell, and the wrapper is what carries the mark.
 *
 * Bounded, and it has to be. The walk stops at init, at a repeat (a wrong ppid
 * is a cycle waiting to happen), and at a fixed depth — this runs on a poll,
 * and an unbounded loop over /proc on a poll is a hang nobody would attribute
 * to a ports panel.
 *
 * Measured before it was written: agentglass's own installed server comes back
 * false, because relaunching detaches it to systemd — the ancestry is
 * agentglass-server, the Electron shell, systemd. A dev server left behind by
 * a session comes back true. Had that not held, the signal would have been
 * worthless and this function would not exist.
 *
 * WHAT IT CANNOT DO, and this is not a defect to be fixed later: the evidence
 * lives in the ancestry, so it dies with it. A server started through `setsid`
 * whose launching shell has since exited is reparented to init, and the chain
 * that led back to the agent is simply gone — measured on exactly such a
 * process, which came back false while a sibling that kept its shell came back
 * true. So a false here means "nothing says an agent started this", never
 * "a person did". The age beside it is what covers that gap: whatever started
 * it, a listener that has been up for four hours is the one worth looking at.
 */
/** One step up the tree. The seam exists so the walk can be tested against a
 *  process tree that is written down rather than one that has to be running. */
export type ProcStep = (pid: number) => { cmdline: string; ppid: number } | null;

const procFromSlashProc: ProcStep = (pid) => {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m);
    if (!m) return null;
    return { cmdline: cmdlineOf(pid), ppid: Number(m[1]) };
  } catch { return null; }
};

export function startedByAgent(pid: number, step: ProcStep = procFromSlashProc): boolean {
  const seen = new Set<number>();
  let cur = pid;
  for (let depth = 0; depth < 8 && cur > 1; depth++) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const info = step(cur);
    if (!info) return false;
    // Skips depth 0 on purpose: the process itself is the server, and matching
    // its own command line would only ever be a false positive.
    if (depth > 0 && AGENT_SHELL.test(info.cmdline)) return true;
    if (!Number.isInteger(info.ppid) || info.ppid <= 1) return false;
    cur = info.ppid;
  }
  return false;
}

/**
 * The chain that started `pid`, nearest first.
 *
 * The same walk `startedByAgent` does, kept separate because they answer
 * different questions: that one asks yes-or-no and can stop the moment it finds
 * an agent shell, this one has to keep going to the top. Sharing the `ProcStep`
 * seam means both are testable against a tree that is written down.
 *
 * Starts at the PARENT. The process itself is already the subject of the row it
 * appears on, and repeating it would spend a third of the width saying what the
 * reader just read.
 *
 * Stops at init rather than including it: every chain on a Linux box ends at
 * pid 1, so it distinguishes nothing and costs a rung. The depth cap is what
 * keeps a deep tree from turning a row into a paragraph, and the `seen` set is
 * for the case that should be impossible — /proc has reported cycles under
 * namespace churn, and a ports panel should not be the thing that hangs.
 */
export function ancestryOf(pid: number, step: ProcStep = procFromSlashProc, max = 5): Forebear[] {
  const out: Forebear[] = [];
  const seen = new Set<number>();
  let cur = pid;
  // `max` counts rungs pushed, not steps taken: one forebear per pass, so the
  // bound is the length of the chain the row will have to fit.
  for (let depth = 0; depth < max && cur > 1; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const info = step(cur);
    if (!info) break;
    if (!Number.isInteger(info.ppid) || info.ppid <= 1) break;
    const parent = step(info.ppid);
    out.push({ pid: info.ppid, name: parent ? shortName(parent.cmdline) : String(info.ppid) });
    cur = info.ppid;
  }
  return out;
}

/**
 * A command line reduced to the thing you would say out loud.
 *
 * `/usr/bin/bun run src/index.ts` is "bun"; `node /path/to/vite` is "node".
 * The interpreter rather than the script on purpose — two `bun`s are told apart
 * by their working directory, which the row already carries, and a basename
 * that changes with every script makes the chain unreadable as a shape.
 */
function shortName(cmdline: string): string {
  const argv0 = cmdline.split(/\s+/)[0] ?? "";
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  // A login shell is spelled `-bash`; the dash is a convention, not a name.
  return (base.startsWith("-") ? base.slice(1) : base) || "?";
}

/** Bound to everything, rather than to this machine. `::` is the v6 spelling of
 *  the same decision, and `ss` prints the wildcard as `*` on some builds. */
/**
 * Is the binary behind this pid gone from disk?
 *
 * The kernel keeps the inode alive for a running process, so `/proc/<pid>/exe`
 * still resolves after the file is deleted — it marks it by appending
 * " (deleted)" to the target. That is the whole detection, and it is why this
 * cannot be answered by stat-ing a path: the path is exactly what no longer
 * exists.
 *
 * A fact, not a fault. A rebuild replaces a binary underneath whatever is still
 * running it, which is the ordinary case here and also the reason a server can
 * behave like a version you no longer have on disk.
 */
export function exeDeleted(pid: number): boolean {
  try {
    return readlinkSync(`/proc/${pid}/exe`).endsWith(" (deleted)");
  } catch {
    // Gone, or not ours. Neither is "the binary was deleted".
    return false;
  }
}

export function isPublicBind(addr: string): boolean {
  return addr === "0.0.0.0" || addr === "::" || addr === "*";
}

/** Enough of the command line to tell two `node`s apart, and no more: a webpack
 *  invocation can be two kilobytes of flags, and none of it fits in a row. */
function cmdlineOf(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean).join(" ").slice(0, 160);
  } catch { return ""; }
}
