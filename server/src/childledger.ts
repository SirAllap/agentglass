/*
 * The long-lived children this server starts do not die with it.
 *
 * Measured on one machine after 2.6 days and dozens of restarts: 39
 * `udisksctl monitor`, 43 `gio`, 31 `git` and 16 `inotifywait` processes were
 * alive with systemd as their parent, the oldest `udisksctl monitor` 2.6 days
 * old. `volumes.ts` starts a monitor per server boot, so every desktop install
 * left one behind; the same is true of gio's mount listener and git's object
 * reader, which an early return in the export never stops.
 *
 * Two halves, and neither matches on a name. Every child is written to a
 * ledger owned by this process — `children.<host>.<boot>.<pid>.json`, carrying
 * this process's pid, its own start time and the boot — with each child's pid,
 * the kernel's start time for that pid and the same boot. A pid alone is not
 * an identity — the kernel reuses one — so a signal is sent only while the
 * start time still matches. And the start time is ticks since boot, which
 * restarts from zero at every boot while the file survives one, so the boot is
 * compared first: a record from another boot is dropped, never signalled. On
 * the way out the children are killed from `process.on("exit")`, which also
 * runs for SIGINT/SIGTERM because index.ts exits through it; on the way in
 * every ledger whose OWNER is gone is read and its survivors are killed. A
 * ledger whose owner still answers to its recorded start time belongs to a
 * server that is running right now, and is left untouched.
 *
 * The Linux `/proc/<pid>/stat` field read here is the start time in clock
 * ticks since boot: constant for the life of the process and unaffected by the
 * wall clock. The `ps -o lstart=` fallback, used where /proc does not exist
 * (macOS is a packaged target), is a one-second wall-clock approximation: it
 * leaks when the string is spelled differently — another LANG/LC_ALL, a DST
 * change — and a pid recycled inside the same second compares equal. Only the
 * /proc path proves identity; that is this module's ceiling off Linux.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export interface ChildRecord {
  /** Kernel process id. */
  pid: number;
  /** `/proc/<pid>/stat` field 22, or `ps -o lstart=` off Linux. Empty never matches. */
  start: string;
  /** The boot this pid was seen on. Empty never matches: ticks restart at every boot. */
  boot: string;
  /** What was started, for a person reading the ledger; never used to find it. */
  cmd: string;
}

/** The server that wrote a ledger: its pid, that pid's start time and the boot. */
interface Owner {
  pid: number;
  start: string;
  boot: string;
}

interface Ledger {
  owner: Owner;
  children: ChildRecord[];
}

/** The server's own state directory, the same answer every other module reads. */
export function stateDir(): string {
  return process.env.AGENTGLASS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
}

/** One file per host, boot and pid: two boots never share one, and neither do
 *  two servers on one state dir. Two pid namespaces on the same host with the
 *  same hostname can still collide — that is a leak, never a wrong kill, since
 *  a foreign child's stamp cannot match inside this namespace. The legacy
 *  `children.<pid>.json` shape is still matched when reaping. */
const LEDGER_NAME = /^children\..+\.json$/;

const safeName = (s: string): string => s.replace(/[^\w.-]/g, "_");

/** Identifies the boot, so a pid recorded before a reboot is never mistaken
 *  for a live process: the start stamp counts ticks since boot and pids are
 *  handed out from low numbers again, so `(pid, start)` repeats across boots
 *  while the ledger survives one. Same shape as `db.ts`, copied rather than
 *  imported because that module opens the database. Empty when the kernel will
 *  not say: the rows are then not trusted by a later boot, so its children leak
 *  instead of being signalled. */
let cachedBoot: string | null = null;

export function bootId(): string {
  if (cachedBoot !== null) return cachedBoot;
  let boot = "";
  if (process.platform === "darwin") {
    try {
      const r = Bun.spawnSync(["sysctl", "-n", "kern.boottime"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const m = /sec\s*=\s*(\d+)/.exec(r.stdout.toString());
      boot = m ? `boot:${m[1]}` : "";
    } catch { /* no boot id: the next boot drops the rows, so they leak */ }
  } else {
    try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* same: leak, not a wrong signal */ }
  }
  cachedBoot = boot;
  return boot;
}

export function ledgerFile(pid: number = process.pid): string {
  const host = safeName(hostname() || "nohost");
  const boot = safeName(bootId() || "noboot");
  return join(stateDir(), `children.${host}.${boot}.${pid}.json`);
}

/** Seconds between SIGTERM and SIGKILL for a child that ignores the first. */
export const STOP_GRACE_MS = 3_000;

/** Fields of `/proc/<pid>/stat` from field 3 on, or `null` when it cannot be
 *  read. Parsing starts after the last `)` because field 2 is the command name
 *  in parentheses and may contain spaces and parens of its own. */
function procFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch { return null; }
}

/**
 * A pid's start time, as the kernel reports it. Must agree with whatever this
 * process recorded earlier for the same pid; a reused pid has another one.
 */
export function startStamp(pid: number): string {
  const fields = procFields(pid);
  if (fields) return fields[19] ?? "";
  try {
    const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    return r.stdout.toString().trim();
  } catch {
    return "";
  }
}

/** This process's own identity, read once: it cannot change while it runs. */
let selfOwner: Owner | null = null;

function owner(): Owner {
  if (!selfOwner) selfOwner = { pid: process.pid, start: startStamp(process.pid), boot: bootId() };
  return selfOwner;
}

/** `null` for anything that is not a readable ledger of ours: a file whose
 *  owner cannot be read is never used as permission to signal or to delete. A
 *  child record with no boot is dropped — a tick count without its boot cannot
 *  name the process that carried it. */
function readLedger(file: string): Ledger | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = (raw as { owner?: Partial<Owner> }).owner;
  if (!o || !Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
  if (typeof o.start !== "string" || typeof o.boot !== "string") return null;
  const list = (raw as { children?: unknown }).children;
  if (!Array.isArray(list)) return null;
  const children: ChildRecord[] = [];
  for (const r of list as Partial<ChildRecord>[]) {
    if (!r || !Number.isInteger(r.pid) || (r.pid as number) <= 0) continue;
    if (typeof r.start !== "string" || r.start === "") continue;
    if (typeof r.boot !== "string" || r.boot === "") continue;
    children.push({ pid: r.pid as number, start: r.start, boot: r.boot, cmd: typeof r.cmd === "string" ? r.cmd.slice(0, 120) : "" });
  }
  return { owner: { pid: o.pid as number, start: o.start, boot: o.boot }, children };
}

/** Whole-file replace, so a crash mid-write cannot leave half a ledger. */
function writeLedger(file: string, owner: Owner, records: ChildRecord[]): void {
  try {
    if (records.length === 0) { removeIfOwner(file, owner); return; }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ owner, children: records } satisfies Ledger), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* a state dir that cannot be written only costs the next boot's reap */ }
}

/** Delete only a file this exact process wrote; anything else stays for its own
 *  owner or for the next boot's reap. */
function removeIfOwner(file: string, owner: Owner): void {
  const ledger = readLedger(file);
  if (!ledger) return;
  const kept = ledger.owner;
  if (kept.pid !== owner.pid || kept.start !== owner.start || kept.boot !== owner.boot) return;
  try { rmSync(file, { force: true }); } catch { /* gone already */ }
}

/** Signal only while the pid still carries the start time recorded with it,
 *  on the boot it was recorded on. */
function signalIfSame(rec: ChildRecord, sig: NodeJS.Signals): boolean {
  if (!rec.start || rec.boot !== bootId()) return false;
  if (startStamp(rec.pid) !== rec.start) return false;
  try { process.kill(rec.pid, sig); return true; } catch { return false; }
}

interface Tracked {
  rec: ChildRecord;
  /** Resolved at track time, never re-derived from the environment later. */
  file: string;
  owner: Owner;
}

const tracked = new Map<number, Tracked>();
let hooked = false;

function recordsFor(file: string): ChildRecord[] {
  const out: ChildRecord[] = [];
  for (const e of tracked.values()) if (e.file === file) out.push(e.rec);
  return out;
}

function onExit(): void {
  // SIGKILL directly: this runs while the process is already leaving, and a
  // monitor that ignored SIGTERM is exactly the leak this exists for.
  const matched = new Set<string>();
  for (const e of tracked.values()) if (signalIfSame(e.rec, "SIGKILL")) matched.add(e.file);
  // Same reason as the reap's finish(): a queued SIGKILL is not an exit, so a
  // file whose child matched stays for the next boot to check.
  for (const e of tracked.values()) if (!matched.has(e.file)) removeIfOwner(e.file, e.owner);
}

function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", onExit);
}

function forget(pid: number): void {
  const e = tracked.get(pid);
  if (!e) return;
  tracked.delete(pid);
  writeLedger(e.file, e.owner, recordsFor(e.file));
}

interface Spawned {
  pid?: number;
  exited?: Promise<number>;
}

/**
 * Record a child this process started and make it die with the process. Call
 * it with the same `Bun.spawn` result the caller keeps, so a child that is
 * stopped normally is forgotten through `exited`.
 */
export function trackChild(proc: Spawned, cmd: string): void {
  const pid = proc?.pid;
  if (!pid) return;
  const start = startStamp(pid);
  if (!start) {
    // No start time means no way to tell this pid from a reused one later.
    console.warn(`[agentglass] child ${pid} (${cmd}) not recorded: it has no start time, so it will not be stopped on exit`);
    return;
  }
  ensureHook();
  const own = owner();
  const file = ledgerFile();
  tracked.set(pid, { rec: { pid, start, boot: own.boot, cmd }, file, owner: own });
  writeLedger(file, own, recordsFor(file));
  void proc.exited?.then(() => forget(pid)).catch(() => { /* it never started */ });
}

/** Stop one child by the pid this process recorded, never by name. The record
 *  stays in the ledger until the child actually exits, so an exit before the
 *  SIGKILL timer still reaches it through `onExit`. */
export function stopChild(pid: number): void {
  const e = tracked.get(pid);
  if (!e) return;
  signalIfSame(e.rec, "SIGTERM");
  setTimeout(() => signalIfSame(e.rec, "SIGKILL"), STOP_GRACE_MS).unref?.();
}

function ledgerFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => LEDGER_NAME.test(n)).map((n) => join(dir, n));
  } catch { return []; }
}

/** True only when that exact process is still there. The boot is checked
 *  first: a process recorded before a reboot is gone by definition, whatever
 *  pid carries its number now. Then `kill(pid, 0)`, where EPERM means the pid
 *  exists and belongs to somebody else — alive, just not ours to signal — and
 *  only ESRCH means gone. A stamp that cannot be read (hidepid, another uid)
 *  counts as alive: its children leak rather than be killed while it runs. */
function ownerAlive(o: Owner): boolean {
  if (o.boot !== bootId()) return false;
  if (o.pid === process.pid) return true;
  if (!o.start) return true;
  try {
    process.kill(o.pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (procFields(o.pid)?.[0] === "Z") return false; // a zombie answers, but it is gone
  const seen = startStamp(o.pid);
  return seen === "" || seen === o.start;
}

/** SIGTERM the records of a dead owner, and remove their file only once the
 *  SIGKILL pass has run and nothing matches any more — a process that exits
 *  inside the grace window leaves the file for the next boot instead of losing
 *  the children that ignored SIGTERM, and so does one that has not answered
 *  its SIGKILL yet (a child blocked on a device can still be there). */
function reapFile(file: string, owner: Owner, records: ChildRecord[]): number {
  let stopped = 0;
  for (const rec of records) if (signalIfSame(rec, "SIGTERM")) stopped++;
  const finish = () => {
    let matched = false;
    for (const rec of records) if (signalIfSame(rec, "SIGKILL")) matched = true;
    if (!matched) removeIfOwner(file, owner);
  };
  // Nothing accepted the SIGTERM, so nothing is waiting on the grace period.
  if (stopped === 0) finish();
  else setTimeout(finish, STOP_GRACE_MS).unref?.();
  return stopped;
}

/**
 * The startup reap: stop the children whose recorded owner is gone, and only
 * those. A ledger whose owner still answers to its own start time belongs to a
 * running server — the children are its live children and none of them is
 * touched. A record from another boot, or whose pid now belongs to somebody
 * else, is dropped without a signal.
 */
export function reapRecordedChildren(dir = stateDir()): number {
  let stopped = 0;
  for (const file of ledgerFiles(dir)) {
    const ledger = readLedger(file);
    if (!ledger) continue;
    if (ownerAlive(ledger.owner)) continue;
    stopped += reapFile(file, ledger.owner, ledger.children);
  }
  return stopped;
}
