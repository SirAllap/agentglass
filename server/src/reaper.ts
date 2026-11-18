/*
 * What a worker started and left behind, stopped after its window is gone.
 *
 * Measured on one machine on 2026-11-03: servers started from a worker's
 * `bash -c` (`bun server/src/index.ts`, a probe on port 4731) were still alive
 * 28-37 h later with `systemd --user` as their parent, holding 8 GB of RAM. The
 * window they were started in had long closed. Nothing owned them: the ledger
 * in childledger.ts covers children of THIS process, and the `nohup` that kept
 * them alive through the hangup also put them under the user manager, where no
 * parent chain says whose they were.
 *
 * The launcher is the fix, and this is the net under it. `ownerLaunch` hands
 * every window this app opens for an agent its name in `AGX_OWNER` and a private
 * `TMPDIR` in `AGX_OWNER_TMP`, so a `nohup`, a `setsid` and a `bash -c` all
 * carry the attribution with them into wherever they reparent. A process is a
 * leftover when all of these hold, and nothing else is ever signalled:
 *
 *   - it carries an owner, and that owner has no window: the engine is asked for
 *     both the window's name and the option the launch pinned to it, because a
 *     person can rename a tab (and a dot in a name is rewritten out of it);
 *   - it is older than an hour, so a worker still starting is never touched;
 *   - its parent is init or this user's `systemd --user`, which is what a
 *     process whose launcher went away looks like;
 *   - it belongs to this user, and it is not this server, an ancestor of it, or
 *     a child of it (childledger.ts owns those).
 *
 * Never by command line. `pkill -f` killed a person's own app twice on this
 * machine because a probe and the real installation share a binary path, and a
 * pattern is not an identity: the pid is sent a signal only while its kernel
 * start time still matches the one read a moment earlier. The owner name is
 * attribution read from the process's own environment, not a match on what it
 * happens to be called.
 *
 * Cost: one `/proc` walk per sweep (10 minutes) plus one `environ` read per
 * process this user owns — and the same walk runs on the START path, where
 * `ownerLaunch` and `dropScratch` ask `scratchHeld` whether the directory is
 * still in use: once per start, twice on a launch whose window never opens, and
 * synchronously, before the window opens. On the machine measured that is a few
 * hundred reads every ten minutes, and only rows carrying an owner are looked
 * at twice.
 *
 * Ceiling: this is Linux. `/proc/<pid>/environ` is what makes the attribution
 * readable, and macOS has no equivalent this app can ask without spawning a
 * process per pid, so there the scan finds nothing and nothing is stopped.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STOP_GRACE_MS } from "./childledger.ts";
import { cmdlineOf, walkProcs } from "./machine.ts";
import { setIntervalAs, setTimeoutAs } from "./loopwatch.ts";

/** The variable a launched window and everything under it carries. */
export const OWNER_VAR = "AGX_OWNER";
/** Where that owner's own `TMPDIR` is, so a leftover's scratch can go with it. */
export const OWNER_TMP_VAR = "AGX_OWNER_TMP";
/** The tmux window option the same owner is pinned to. A window NAME is a label
 *  a person can rename (and this app rewrites a dot out of), so liveness asks
 *  this too: it is set at launch and travels with the window (tmuxpane.ts). */
export const OWNER_OPTION = "@agx_owner";
/** Prefix of the one scratch directory this app gives an owner. */
export const OWNER_TMP_PREFIX = "agx-owner-";
/** How often the net is cast. A six-hour process does not need a minute. */
export const REAP_EVERY_MS = 10 * 60_000;
/** Younger than this is a worker still starting, never a leftover. */
export const OWNER_MIN_AGE_MS = 60 * 60_000;

/** The same name rule agentops.ts holds windows to, copied because importing
 *  it would close a cycle: agentops imports this module to stamp a launch. */
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Where one owner's private scratch lives. Deterministic per owner so that
 *  the end of its window can find it without a registry. */
export function ownerTmpDir(owner: string): string | null {
  return OWNER_NAME.test(owner) ? join(tmpdir(), OWNER_TMP_PREFIX + owner) : null;
}

/** Whether a process this user owns still names this directory as its scratch.
 *  A relaunch under a name whose window is gone is allowed (`agentops`), and
 *  the leftover it left keeps writing into the directory it was given. */
export function scratchHeld(dir: string, scan: () => OwnedProc[] = scanOwned): boolean {
  const want = resolve(dir);
  return scan().some((r) => !!r.tmp && resolve(r.tmp) === want);
}

/** What a window is launched with: the attribution its children inherit, and a
 *  `TMPDIR` inside the directory this app can remove afterwards. The directory
 *  is emptied at a start whose predecessor is gone, and only then: emptying it
 *  under a live process takes its `TMPDIR` away mid-run (ENOENT on its next
 *  temp write), and the reaper never sees the file it lost. */
export function ownerLaunch(owner: string, held: (dir: string) => boolean = scratchHeld): { dir: string | null; env: Record<string, string> } {
  const dir = ownerTmpDir(owner);
  if (!dir) return { dir: null, env: { [OWNER_VAR]: owner } };
  if (!held(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, env: { [OWNER_VAR]: owner, [OWNER_TMP_VAR]: dir, TMPDIR: dir } };
}

/** The scratch of a launch that never ran, unless something is still writing in
 *  it: a relaunch whose window does not open must not take the directory out
 *  from under the previous run's leftover either. */
export function dropScratch(dir: string | null, held: (dir: string) => boolean = scratchHeld): void {
  if (!dir || held(dir)) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** The owner and scratch a process's environment names, or null. Read from
 *  `/proc/<pid>/environ`, which is the environment at exec: inherited, so a
 *  process two shells below the window still carries it. */
export function ownerFromEnviron(raw: string | Uint8Array): { owner: string; tmp: string } | null {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let owner = "";
  let tmp = "";
  for (const entry of text.split("\u0000")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const key = entry.slice(0, at);
    if (key === OWNER_VAR) owner = entry.slice(at + 1);
    else if (key === OWNER_TMP_VAR) tmp = entry.slice(at + 1);
  }
  return owner ? { owner, tmp } : null;
}

/** One process that says whose it is. `mine` marks the tree this server itself
 *  is in — itself, an ancestor, a child — which is never this module's to stop. */
export interface OwnedProc {
  pid: number;
  ppid: number;
  start: string;
  ageMs: number;
  owner: string;
  tmp: string;
  mine: boolean;
}

export interface ScanOptions {
  selfPid?: number;
  /** Injectable for a table test; the kernel's uptime otherwise. */
  uptimeSec?: number;
}

/** This server's own place in the tree: itself, everything it came from, and
 *  everything it started. A reused pid could put a stranger there, which costs
 *  a leak, never a wrong kill. */
function selfTree(pids: { pid: number; ppid: number }[], self: number): Set<number> {
  const byPid = new Map(pids.map((p) => [p.pid, p]));
  const out = new Set<number>([self]);
  for (let pid = self, seen = 0; pid > 1 && seen < 64; seen++) {
    const parent = byPid.get(pid)?.ppid;
    if (!parent || out.has(parent)) break;
    out.add(parent);
    pid = parent;
  }
  const children = new Map<number, number[]>();
  for (const p of pids) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const queue = [self];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** Every process this user owns that names an owner, with the start time the
 *  kernel gave it, so a kill a moment later can prove it is the same process. */
export function scanOwned(opts: ScanOptions = {}): OwnedProc[] {
  const walk = walkProcs();
  if (!walk) return [];
  let uptimeSec = opts.uptimeSec;
  if (uptimeSec === undefined) {
    try { uptimeSec = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch { return []; }
  }
  if (!Number.isFinite(uptimeSec)) return [];
  const mine = selfTree(walk.rows, opts.selfPid ?? process.pid);
  const out: OwnedProc[] = [];
  for (const row of walk.rows) {
    // Only processes that name an owner are candidates, so the environ read is
    // the expensive half and it happens once per process, not once per rule.
    let raw: string;
    try { raw = readFileSync(`/proc/${row.pid}/environ`, "utf8"); } catch { continue; }
    const said = ownerFromEnviron(raw);
    if (!said) continue;
    const ticks = walk.raw.get(row.pid)?.start;
    if (ticks === undefined) continue;
    // Field 22 is start time in clock ticks since boot; 100 Hz is what Linux
    // has shipped for every architecture this app runs on (machine.ts says so
    // too), and there is no syscall to read it from another process.
    const ageMs = Math.max(0, (uptimeSec - ticks / 100) * 1000);
    out.push({ pid: row.pid, ppid: row.ppid, start: String(ticks), ageMs, owner: said.owner, tmp: said.tmp, mine: mine.has(row.pid) });
  }
  return out;
}

/** Init and this user's `systemd --user`: the parents whose children have no
 *  launcher left. Read from `/proc` rather than `ps`, because this shares the
 *  one walker the rest of the app uses. */
export function nobodyPids(pids: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const pid of pids) {
    if (pid === 1) { out.add(pid); continue; }
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (comm === "systemd" && cmdlineOf(pid).includes("--user")) out.add(pid);
    } catch { /* a parent that just exited is nobody's */ }
  }
  return out;
}

export interface ReapRule {
  /** Owners whose window is still on the engine. */
  live: ReadonlySet<string>;
  /** Parents that mean the launcher is gone. */
  nobody: ReadonlySet<number>;
  /** Younger than this is a worker still starting. */
  minAgeMs: number;
  /** Reap this owner and no other, whatever its age: its window is known gone. */
  only?: string;
}

/** The rows the rule picks. Pure, so every clause is a table row in the test. */
export function reapableOwned(rows: readonly OwnedProc[], rule: ReapRule): OwnedProc[] {
  return rows.filter((r) =>
    !r.mine
    && !!r.owner
    && rule.nobody.has(r.ppid)
    && (rule.only !== undefined ? r.owner === rule.only : !rule.live.has(r.owner) && r.ageMs > rule.minAgeMs));
}

/** The scratch this owner was given, never another owner's and never any other
 *  path an environment could name. `AGX_OWNER_TMP` is inherited, so a window can
 *  carry the scratch of whatever worker last ran in its session; matching the
 *  prefix alone removed a live owner's scratch with its processes still writing
 *  in it, so what is checked is the owner, not the name it comes out of. */
export function ownScratchOf(dir: string, owner: string): string | null {
  if (!dir) return null;
  const own = ownerTmpDir(owner);
  return own && resolve(dir) === own ? own : null;
}

export interface ReapDeps {
  scan?: () => OwnedProc[];
  /** The owners whose window is on the engine, or null when that could not be
   *  read: a read that failed says nothing about any window, so nothing is. */
  live?: () => ReadonlySet<string> | null | Promise<ReadonlySet<string> | null>;
  nobody?: () => ReadonlySet<number>;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  startOf?: (pid: number) => string;
  graceMs?: number;
  minAgeMs?: number;
  removeDir?: (dir: string) => void;
  only?: string;
}

/** Every parent in the scan that means "nobody owns this": init, and this
 *  user's manager (looked up, not assumed — pid 1487 here, another elsewhere). */
function defaultNobody(rows: readonly OwnedProc[]): Set<number> {
  return nobodyPids([...new Set(rows.map((r) => r.ppid))]);
}

function startStampOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  } catch { return ""; }
}

/** One outage, one line: the net runs every ten minutes and the board polls
 *  `reconcile`, so a dead engine would otherwise be a line per look. */
let unknownLogged = false;

/**
 * Stop the leftovers one rule picks, and only those: SIGTERM now, SIGKILL after
 * the grace to the same pid and start time, then the scratch of every owner
 * whose processes were stopped. Returns what was asked to stop, so the caller
 * can log a number rather than a claim.
 */
export async function reapOwned(deps: ReapDeps = {}): Promise<{ stopped: number; owners: string[] }> {
  const rows = (deps.scan ?? (() => scanOwned()))();
  const live = deps.live ? await deps.live() : new Set<string>();
  /* A liveness read that FAILED is not a fact about any window, and the empty
     set it used to become made every owner look gone: one failed `list-windows`
     and a chat window's `nohup`'d dev server was killed. Nothing is stopped on
     an unknown, and the unknown is said once per outage rather than every tick
     (and not at all when there is nothing to decide). An owner whose window is
     known gone (`only`) does not consult this. */
  if (live === null && deps.only === undefined) {
    if (rows.length && !unknownLogged) {
      unknownLogged = true;
      console.error("[agentglass] reaper: the engine's windows could not be read; nothing stopped this run");
    }
    return { stopped: 0, owners: [] };
  }
  unknownLogged = false;
  const rule: ReapRule = {
    live: live ?? new Set<string>(),
    nobody: deps.nobody?.() ?? defaultNobody(rows),
    minAgeMs: deps.minAgeMs ?? OWNER_MIN_AGE_MS,
    ...(deps.only !== undefined ? { only: deps.only } : null),
  };
  const picked = reapableOwned(rows, rule);
  const signal = deps.signal ?? ((pid, sig) => { process.kill(pid, sig); });
  const startOf = deps.startOf ?? startStampOf;
  const remove = deps.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

  const owners = [...new Set(picked.map((r) => r.owner))];
  const stopped: OwnedProc[] = [];
  for (const row of picked) {
    // Verified twice — here and again before the SIGKILL. A pid reused between
    // the scan and the signal carries another start time, and the signal is the
    // one thing that must not land on it.
    if (!row.start || startOf(row.pid) !== row.start) continue;
    try { signal(row.pid, "SIGTERM"); stopped.push(row); } catch { /* it went in between */ }
  }

  const dirs = new Set(picked.map((r) => ownScratchOf(r.tmp, r.owner)).filter((d): d is string => !!d));
  // An owner known gone: its scratch goes even when no process was found
  // holding it, since the directory is one this app made for that owner.
  if (deps.only !== undefined) {
    const own = ownerTmpDir(deps.only);
    if (own) dirs.add(own);
  }
  // With an owner known gone there is nothing to wait for: its scratch goes
  // now, since the window it belonged to is already off the engine.
  if (deps.only !== undefined) for (const d of dirs) safeRemove(remove, d);
  if (stopped.length === 0) return { stopped: 0, owners };
  setTimeoutAs("reaper first run", () => {
    for (const row of stopped) {
      if (startOf(row.pid) !== row.start) continue;
      try { signal(row.pid, "SIGKILL"); } catch { /* gone */ }
    }
    // The periodic path leaves the scratch until the grace is over, because a
    // process being stopped may still be writing in it.
    if (deps.only === undefined) for (const d of dirs) safeRemove(remove, d);
  }, deps.graceMs ?? STOP_GRACE_MS).unref?.();
  return { stopped: stopped.length, owners };
}

function safeRemove(remove: (dir: string) => void, dir: string): void {
  try { remove(dir); } catch { /* best effort: the next tick tries again */ }
}

/**
 * One owner's leftovers, for the moment its window is known to have ended. No
 * age gate and no liveness question: the caller has just watched the pane go.
 */
export function reapOwner(owner: string, deps: ReapDeps = {}): Promise<{ stopped: number; owners: string[] }> {
  return reapOwned({ ...deps, only: owner, minAgeMs: 0 });
}

/**
 * The net, on a clock. One run at boot catches what last night left; then every
 * ten minutes, unref'd so a server with nothing else to do can still exit.
 */
export function startReaper(deps: ReapDeps = {}): void {
  const run = (): void => {
    void reapOwned(deps).then(({ stopped, owners }) => {
      if (stopped) console.log(`🧹 processes: stopped ${stopped} left by ${owners.join(", ")}`);
    }).catch((e: unknown) => {
      // A failed sweep is not a reason to take the server with it; the next one
      // starts from the same /proc.
      console.error(`[agentglass] reaper: ${String(e)}`);
    });
  };
  run();
  setIntervalAs("reaper sweep", run, REAP_EVERY_MS).unref?.();
}
