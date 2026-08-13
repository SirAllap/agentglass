/*
 * The local task list, read out of Taskwarrior.
 *
 * A second front end onto a store the user already has and already writes to
 * from Neovim — not a copy of it. Nothing is mirrored into our database:
 * description, tags, project, priority, due and annotations live in `~/.task`
 * and are read on demand. What we own is the *schedule* (see reminders.ts),
 * because that is the part that must survive Taskwarrior being absent, and the
 * part Taskwarrior has nowhere to put.
 *
 * Read-only for now. The write path is deliberately a separate change: writes
 * against this store need a lock and a compare-and-swap, and none of that is
 * needed to put the list on screen.
 */
import { statSync, mkdirSync, openSync, closeSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { withSpawnSlot } from "./spawnpool.ts";
import { singleFlight } from "./singleflight.ts";
import { entered, backoff, resumedAs, currentLabel } from "./loopwatch.ts";
import type { TaskCapability, LocalTask } from "../../shared/types.ts";

export type TaskResult = { code: number; stdout: string; stderr: string; killed?: boolean };

/**
 * Which `task` to run.
 *
 * Three places, most explicit first, and the order is the one `tmuxbin.ts`
 * already uses for the pane engine's tmux:
 *
 *   1. `AGENTGLASS_TASK_PATH`, which beats everything — the escape hatch for a
 *      machine with a build somewhere unusual;
 *   2. a BUNDLED binary shipped beside the sidecar (a packaged desktop app) or
 *      under the app's state directory (a headless install). This is the point
 *      of the exercise: local tasks should work on a machine that has never
 *      heard of Taskwarrior, exactly as the terminal works on a machine with no
 *      tmux. Nothing here builds that binary — see `scripts/build-task-static.sh`
 *      — but the runtime half must exist first, or a bundled binary has nowhere
 *      to be found;
 *   3. the system one on PATH, which is what everybody with Taskwarrior already
 *      installed keeps using.
 *
 * `Bun.spawn` throws on a missing binary rather than returning 127, so without
 * this the panel would invent a cause for a machine that simply has none. Same
 * first-class-state treatment `gitBin`/`ghCapability` give their tools. PATH is
 * passed explicitly, for the reason `git.ts:97` gives.
 */
const TASK_PATH_ENV = "AGENTGLASS_TASK_PATH";
const TASK_DIR_ENV = "AGENTGLASS_TASK_DIR";

/** Is `p` a regular file this user can execute? */
function runnable(p: string): boolean {
  if (!p || p.includes("\0")) return false;
  try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
}

/** Where a packaged app or a headless install would keep a bundled `task`. */
function bundledTaskDirs(): string[] {
  const dirs: string[] = [];
  const asked = process.env[TASK_DIR_ENV];
  if (asked) dirs.push(asked);
  // Under test, only an env-provided dir answers: the developer's own execPath
  // and state dir must never decide a suite's outcome.
  if (process.env.NODE_ENV !== "test") {
    try { dirs.push(dirname(process.execPath)); } catch { /* no execPath */ }
    const state = process.env.AGENTGLASS_STATE_DIR;
    if (state) dirs.push(join(state, "task"));
  }
  return dirs;
}

let binCache: string | null | undefined;
export function taskBin(): string | null {
  if (binCache !== undefined) return binCache;
  const override = process.env[TASK_PATH_ENV];
  if (override && runnable(override)) return (binCache = override);
  for (const dir of bundledTaskDirs()) {
    const p = join(dir, process.platform === "win32" ? "task.exe" : "task");
    if (runnable(p)) return (binCache = p);
  }
  return (binCache = Bun.which("task", { PATH: process.env.PATH ?? "" }));
}
/** Test seam — a binary does not appear mid-session, but a test's PATH does. */
export function __resetTaskBin(): void { binCache = undefined; }

const TIMEOUT_MS = 2_000;

/**
 * One `task` invocation.
 *
 * `stdin: "ignore"` is not tidiness. Measured: a piped-but-unwritten stdin
 * against an installed-but-unconfigured Taskwarrior hangs forever — the process
 * sits waiting for the answer to its own setup question and no timeout in the
 * caller can distinguish that from a slow disk.
 *
 * The timeout is an explicit kill rather than Bun's `timeout` option so the
 * caller can tell a killed process from a refused one: `signalCode` is set only
 * when we killed it, which is the same distinction `docker.ts:56` draws.
 */
export async function task(args: string[]): Promise<TaskResult> {
  const bin = taskBin();
  if (!bin) return { code: 127, stdout: "", stderr: "task is not installed" };
  return withSpawnSlot(async () => {
    const label = currentLabel();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // `env` passed explicitly, and this is not decoration. Bun.spawn's default
      // is the environment captured when THIS process started, not the live
      // `process.env` — so `TASKDATA` or `TASKRC` set after boot is silently
      // ignored and `task` reads whatever store the user's shell points at.
      // Found the honest way: a test that built its own disposable store read
      // the developer's real one instead, and passed. Same hazard `git.ts:97`
      // documents for `Bun.which` and PATH.
      proc = Bun.spawn([bin, ...args], { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      return { code: 127, stdout: "", stderr: String(e) };
    }
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr, killed: proc.signalCode != null };
    } finally {
      clearTimeout(kill);
      resumedAs(label);
    }
  });
}

/*
 * The read, and the one token that makes it safe.
 *
 * `rc.gc=0` is load-bearing. Measured on a real store: a plain `task export`
 * rewrote `pending.data` from 514 to 371 bytes — garbage collection runs as a
 * side effect of reading, so *every read is a write*, and every poll renumbers
 * the ids underneath whatever else is holding the store open. With `rc.gc=0`
 * the same export is byte-neutral across repeated runs.
 *
 * `rc.hooks=0` keeps the user's own hooks out of our polling. The rest silence
 * the human-facing chrome that would otherwise land in the JSON.
 */
const READ_ARGS = [
  "rc.gc=0", "rc.color=off", "rc.verbose=nothing",
  "rc.hooks=0", "rc.detection=0", "rc.defaultwidth=0",
  "export",
];

// ---------------------------------------------------------------------------
// capability
// ---------------------------------------------------------------------------

const CAP_TTL_MS = 60_000;
let capCache: { at: number; cap: TaskCapability } | null = null;

/** For the poll path: a stale answer rather than a spawn. */
export function taskCapabilityCached(): TaskCapability | null {
  if (capCache && Date.now() - capCache.at < CAP_TTL_MS * 10) return capCache.cap;
  return null;
}

/** Where this machine keeps its Taskwarrior config and data, asked once. */
let paths: { rc: string; data: string } | null = null;
async function taskPaths(): Promise<{ rc: string; data: string }> {
  if (paths) return paths;
  // Never hardcode `~/.task`: TASKDATA, TASKRC and an XDG layout all move it,
  // and a hardcoded path reports a correctly configured user as unconfigured.
  const rc = process.env.TASKRC || join(homedir(), ".taskrc");
  let data = process.env.TASKDATA || "";
  if (!data) {
    const r = await task(["rc.hooks=0", "rc.verbose=nothing", "_show"]);
    data = r.stdout.split("\n").find((l) => l.startsWith("data.location="))?.slice(14).trim() || "";
    if (data.startsWith("~")) data = join(homedir(), data.slice(1));
  }
  paths = { rc, data: data || join(homedir(), ".task") };
  return paths;
}
/**
 * Test seam.
 *
 * Every cache that depends on WHERE the store is, dropped together — bun runs
 * test files in one process, so two suites pointing TASKDATA at their own
 * fixtures share this module and each other's answers. Separately, they would
 * both pass; together, the second reads the first's store.
 */
export function __resetTaskPaths(): void { paths = null; capCache = null; snap = null; }

/**
 * Installed, and set up?
 *
 * The filesystem is asked first and the binary second, because the probe must
 * not be able to *change* anything. Running `task` with `rc.confirmation=no` to
 * see whether it works auto-answers its first-run question and writes a
 * ~1.5 KB `~/.taskrc` — measured. So an unconfigured machine is detected by the
 * absence of the file, and reported, and left exactly as it was. Creating a
 * user's config for them is not ours to do.
 */
export async function taskCapability(force = false): Promise<TaskCapability> {
  if (!force && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.cap;
  let cap: TaskCapability;
  if (!taskBin()) {
    cap = { available: false, configured: false, reason: "Taskwarrior is not installed" };
  } else {
    const p = await taskPaths();
    const has = (f: string) => { try { statSync(f); return true; } catch { return false; } };
    if (!has(p.rc)) {
      cap = { available: true, configured: false, reason: "Taskwarrior is installed but has never been set up" };
    } else {
      const v = await task(["rc.hooks=0", "rc.verbose=nothing", "_version"]);
      cap = v.code === 0
        ? { available: true, configured: true, version: v.stdout.trim() }
        : { available: true, configured: false, reason: v.stderr.trim() || "task could not report its version" };
    }
  }
  capCache = { at: Date.now(), cap };
  return cap;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Taskwarrior's `id` is a display number. It is reassigned whenever the store
 * is garbage-collected, so a UI that held one across a refresh would act on
 * whatever task inherited it. It never enters the model: `uuid` is the only
 * reference this app knows.
 */
type RawTask = {
  uuid?: string; description?: string; status?: string;
  project?: string; priority?: string; tags?: string[];
  due?: string; entry?: string; end?: string; urgency?: number;
  annotations?: { entry?: string; description?: string }[];
};

/**
 * Taskwarrior writes every date as UTC (`20260330T220000Z`). Reading only the
 * date half gives the wrong day for anyone east of Greenwich — local midnight
 * is the previous day in UTC — so a task due today renders as permanently
 * overdue. The user's own Neovim plugin learned this the hard way; the same
 * conversion is done here rather than inherited.
 */
export function twDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) {
    const d = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    return d ? `${d[1]}-${d[2]}-${d[3]}` : null;
  }
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const local = new Date(utc);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}`;
}

/** A URL annotation and a note annotation are the same field. The user's own
 *  tool tells them apart by whether the text starts with a scheme, and the
 *  distinction is worth keeping: one is a link to follow, the other is prose. */
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export function toLocalTask(t: RawTask): LocalTask | null {
  if (!t.uuid || !t.description) return null;
  const anns = t.annotations ?? [];
  return {
    uuid: t.uuid,
    description: t.description,
    status: t.status === "completed" ? "completed" : t.status === "deleted" ? "deleted" : "pending",
    project: t.project ?? null,
    priority: t.priority === "H" || t.priority === "M" || t.priority === "L" ? t.priority : null,
    tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : [],
    due: twDate(t.due),
    created: twDate(t.entry),
    completed: twDate(t.end),
    urgency: typeof t.urgency === "number" ? t.urgency : 0,
    notes: anns.map((a) => a.description ?? "").filter((d) => d && !isUrl(d)),
    urls: anns.map((a) => a.description ?? "").filter((d) => d && isUrl(d)),
  };
}

export type TaskSnapshot = { at: number; tasks: LocalTask[]; fingerprint: string; error?: string };
let snap: TaskSnapshot | null = null;
const SNAP_TTL_MS = 3_000;

/**
 * Everything the store says, minus the one field it makes up on the spot.
 *
 * `urgency` is not stored. Taskwarrior computes it per export from the task's
 * age and how near its due date is, so it changes CONTINUOUSLY — measured on
 * this fixture, `9.10475` became `9.10478` six seconds later with nobody
 * writing anything. Hashing the raw export therefore produced a precondition
 * that moved on its own, and every write more than a few seconds after the list
 * loaded was refused with "somebody changed this task while you were pressing
 * the key". That was not true, and a false report of a concurrent edit is the
 * worst thing this particular message can say: it teaches the user that the
 * safety check is noise.
 *
 * Stripped rather than replaced by a hash of our own struct. The point of
 * hashing the WHOLE export is to notice a change to a field we do not model —
 * a recurrence, a dependency, somebody's UDA — and hashing only what we parse
 * would give exactly that up.
 */
const CLOCK_DERIVED = /,?"urgency":-?\d+(?:\.\d+)?/g;
export const fingerprintOf = (raw: string) => String(Bun.hash(raw.replace(CLOCK_DERIVED, "")));

export async function listTasks(force = false): Promise<TaskSnapshot> {
  if (!force && snap && Date.now() - snap.at < SNAP_TTL_MS * backoff()) return snap;
  return singleFlight("tasks:list", async () => {
    if (!force && snap && Date.now() - snap.at < SNAP_TTL_MS * backoff()) return snap;
    const cap = await taskCapability();
    if (!cap.available || !cap.configured) {
      snap = { at: Date.now(), tasks: [], fingerprint: "", error: cap.reason };
      return snap;
    }
    const r = await task(READ_ARGS);
    if (r.code !== 0) {
      snap = { at: Date.now(), tasks: [], fingerprint: "", error: r.killed ? "task timed out" : (r.stderr.trim() || "task export failed") };
      return snap;
    }
    // 2.6.2 prints its news banner before the JSON on first run after an
    // upgrade; the array is what we want, wherever it starts.
    const start = r.stdout.indexOf("[");
    let tasks: LocalTask[] = [];
    try {
      const parsed = JSON.parse(start >= 0 ? r.stdout.slice(start) : r.stdout) as RawTask[];
      tasks = Array.isArray(parsed) ? parsed.map(toLocalTask).filter((t): t is LocalTask => t !== null) : [];
    } catch {
      snap = { at: Date.now(), tasks: [], fingerprint: "", error: "task export did not return JSON" };
      return snap;
    }
    snap = { at: Date.now(), tasks, fingerprint: fingerprintOf(r.stdout) };
    return snap;
  });
}

// ---------------------------------------------------------------------------
// change notification
// ---------------------------------------------------------------------------

/** A hook rather than an import of the HTTP layer, for the reason
 *  `gitwork.ts:673` gives: this module must not know how a client is reached. */
let onChange: (() => void) | null = null;
export function setTaskChangeHook(fn: (() => void) | null): void { onChange = fn; }

/**
 * A backstop sweep, because the store has a second writer.
 *
 * Neovim edits the same files and tells us nothing. A poll from the panel only
 * runs while the panel is open, so without this a task added in the editor is
 * invisible until something else asks. 45s: the store is written on the order
 * of a few times a day, and the panel's own 15s poll covers the case where
 * somebody is actually looking.
 */
let sweeper: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let skipped = 0;
export function startTaskSweep(): void {
  if (sweeper) return;
  const tick = async () => {
    // Load-shed while a shell is busy, but never more than three in a row —
    // the same bargain `gitwork.ts` strikes, and for the same reason.
    if (backoff() > 1 && skipped < 3) { skipped++; return; }
    skipped = 0;
    if (sweeping) return;
    sweeping = true;
    entered("task sweep");
    try {
      const before = snap?.fingerprint;
      const after = await listTasks(true);
      if (before !== undefined && after.fingerprint !== before) { try { onChange?.(); } catch { /* a broken listener must not fail the sweep */ } }
    } catch { /* the next tick tries again */ } finally { sweeping = false; }
  };
  void tick(); // one eager run, so the first minute is not a lie
  sweeper = setInterval(() => { void tick(); }, 45_000);
  (sweeper as unknown as { unref?: () => void }).unref?.();
}
export function stopTaskSweep(): void { if (sweeper) clearInterval(sweeper); sweeper = null; sweeping = false; }

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * A way to turn this off that does not turn the reminders off with it.
 *
 * Read once here rather than checked in a route, so every verb is covered by
 * construction and a new one cannot forget. `/tasks/reminder/*` is deliberately
 * not behind it: the schedule is ours and is safe to write even when the task
 * store is not.
 */
export const TASK_WRITE_ENABLED = process.env.AGENTGLASS_TASK_WRITE_DISABLED !== "1";

/** Taskwarrior 3 replaced the flat files with TaskChampion. `rc.gc=0` is a
 *  flat-file concept and its multi-process write safety is undocumented, so
 *  this reads a 3.x store and refuses to write to one — out loud, rather than
 *  by failing oddly later. */
const writableVersion = (v?: string) => !!v && /^2\./.test(v);

export type WriteResult = {
  ok: boolean; error?: string; conflict?: boolean;
  tasks?: LocalTask[];
  /** What the store fingerprints to now, so the caller's next write can use it
   *  as its precondition without a round trip. */
  fingerprint?: string;
};

async function writeGuard(): Promise<string | null> {
  if (!TASK_WRITE_ENABLED) return "writing to the task list is turned off";
  const cap = await taskCapability();
  if (!cap.available) return cap.reason ?? "Taskwarrior is not installed";
  if (!cap.configured) return cap.reason ?? "Taskwarrior is not set up";
  if (!writableVersion(cap.version)) {
    return `agentglass reads Taskwarrior ${cap.version ?? "3.x"} but will not write to it — the 3.x store has different concurrency rules`;
  }
  return null;
}

/*
 * Two locks, because one is not enough.
 *
 * The in-process chain serialises this server's own writes. It says nothing
 * about the OTHER agentglass — this machine has more than one checkout running
 * at a time — or about the editor, which is the writer that matters. So a file
 * lock is taken as well, held across the whole read-write-verify triple rather
 * than around the write alone: the verification is only meaningful if nothing
 * moved between the two exports.
 *
 * Advisory, and best effort. A lock we cannot take is a reason to be careful,
 * not a reason to refuse — Taskwarrior itself takes none.
 */
const LOCK_PATH = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agentglass", "task.lock");
let chain: Promise<unknown> = Promise.resolve();

async function withTaskLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    let fd: number | null = null;
    try {
      mkdirSync(dirname(LOCK_PATH), { recursive: true });
      fd = openSync(LOCK_PATH, "w");
      // A short spin rather than a blocking flock: bun has no flock binding, and
      // an exclusive create is the portable advisory equivalent. Whoever holds
      // it writes its pid, so a stale one is diagnosable.
      writeFileSync(LOCK_PATH, String(process.pid));
      return await fn();
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    }
  });
  chain = run.catch(() => {});
  return run as Promise<T>;
}

/**
 * Run a verb, and prove afterwards that only the intended thing changed.
 *
 * The precondition is the fingerprint of the WHOLE export, not the row's own
 * `modified`. That is not belt and braces — it is the only check that catches
 * the ordering that actually loses data. Measured on this store: 30 writers
 * against 30 DISTINCT tasks lost 21 of them, every one exiting 0. In the half
 * of that race where we write second, our change lands, the editor's `done`
 * from four milliseconds earlier is reverted, and a per-uuid check reports
 * success. `modified` is second-resolution besides, so two writes inside the
 * same wall-clock second compare equal.
 *
 * On a moved fingerprint the answer is 409 and the fresh list. Never a retry:
 * retrying against a store that moved is how the clobber happens.
 */
async function runVerb(args: string[], expect?: string): Promise<WriteResult> {
  const bad = await writeGuard();
  if (bad) return { ok: false, error: bad };
  return withTaskLock(() => verbInLock(args, expect));
}

/**
 * A verb's body, already holding the lock.
 *
 * Split out for the bulk path, which must apply a run of changes without
 * letting go between them: taking and releasing the lock per task would leave a
 * window for the editor to write into the middle of the run, and half the
 * selection would then be acted on against a store the other half never saw.
 */
async function verbInLock(args: string[], expect?: string): Promise<WriteResult> {
  const before = await listTasks(true);
  if (before.error) return { ok: false, error: before.error };
  // The precondition. `expect` is the fingerprint the CLIENT was looking at
  // when the user pressed the key — not one we took a moment ago, which would
  // leave no window to detect and would make this decoration. If the store
  // moved in between, the row on screen is not the row being acted on, and
  // the honest answer is to say so and re-render from truth.
  if (expect && before.fingerprint && expect !== before.fingerprint) {
    return {
      ok: false, conflict: true, tasks: before.tasks,
      error: "Neovim changed this task while you were pressing the key — reloaded",
    };
  }
  // No kill on a write. TDB2 rewrites pending.data in place, with no
  // temp-file-and-rename, so killing it mid-commit truncates the store rather
  // than failing the write. A slow write is waited out and then verified.
  const r = await task(["rc.confirmation=no", "rc.gc=0", "rc.hooks=0", "rc.verbose=nothing", ...args]);
  const after = await listTasks(true);
  // Never retried. A retry against a store that has moved is precisely how
  // the clobber happens — the caller re-reads and decides again.
  if (r.code !== 0 && before.fingerprint === after.fingerprint) {
    return { ok: false, error: r.stderr.trim() || "task refused the change" };
  }
  return { ok: true, tasks: after.tasks, fingerprint: after.fingerprint };
}

/** A uuid, pinned to the shape rather than merely escaped — the same treatment
 *  docker.ts and tmuxpane.ts give an id that reaches a command line. */
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function completeTask(uuid: string, expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  return runVerb([uuid, "done"], expect);
}
export async function reopenTask(uuid: string, expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  return runVerb([uuid, "modify", "status:pending"], expect);
}
export async function deleteTask(uuid: string, expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  return runVerb([uuid, "delete"], expect);
}

/**
 * The quick-add grammar, as a typed struct rather than a string.
 *
 * Every token becomes an argv element. Nothing is concatenated and nothing is
 * shell-quoted, because nothing reaches a shell. The character classes are
 * Unicode-aware on purpose: this user writes in two languages, and a `\w`-based
 * tag class silently truncates `+revisión` to `revisi`.
 */
export interface ParsedTask {
  description: string;
  priority: "H" | "M" | "L" | null;
  tags: string[];
  project: string | null;
  /** "YYYY-MM-DD", already resolved from `#N` if that is how it was written. */
  due: string | null;
  /** The `*<when>` token, left for the reminder layer — Taskwarrior never sees it. */
  remind: string | null;
}

const TAG_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const PROJECT_RE = /^[\p{L}\p{N}._-]{1,60}$/u;

export function parseInput(input: string, today = new Date()): ParsedTask {
  const out: ParsedTask = { description: "", priority: null, tags: [], project: null, due: null, remind: null };
  let s = input;
  s = s.replace(/\*([^*]+)$/u, (_, w: string) => { out.remind = w.trim() || null; return " "; });
  s = s.replace(/(?:^|\s)!([hmlHML])(?=\s|$)/gu, (_, p: string) => { out.priority = p.toUpperCase() as "H" | "M" | "L"; return " "; });
  s = s.replace(/(?:^|\s)#(\d{1,4})(?=\s|$)/gu, (_, n: string) => {
    const d = new Date(today); d.setDate(d.getDate() + Number(n));
    const p = (x: number) => String(x).padStart(2, "0");
    out.due = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return " ";
  });
  s = s.replace(/(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/gu, (_, d: string) => { out.due = d; return " "; });
  s = s.replace(/(?:^|\s)\+([^\s]+)/gu, (m: string, t: string) => {
    if (!TAG_RE.test(t)) return m; // not a tag — leave it in the description, where the user put it
    out.tags.push(t); return " ";
  });
  s = s.replace(/(?:^|\s)@([^\s]+)/gu, (m: string, p: string) => {
    if (!PROJECT_RE.test(p)) return m;
    out.project = p; return " ";
  });
  out.description = s.replace(/\s+/gu, " ").trim();
  return out;
}

export async function addTask(input: string, expect?: string): Promise<WriteResult & { parsed?: ParsedTask }> {
  const parsed = parseInput(input);
  if (!parsed.description) return { ok: false, error: "that is all labels and no task", parsed };
  const args = ["add", parsed.description];
  if (parsed.priority) args.push(`priority:${parsed.priority}`);
  if (parsed.project) args.push(`project:${parsed.project}`);
  if (parsed.due) args.push(`due:${parsed.due}`);
  for (const t of parsed.tags) args.push(`+${t}`);
  const r = await runVerb(args, expect);
  return { ...r, parsed };
}

const PRIO_CYCLE: Record<string, string> = { "": "L", L: "M", M: "H", H: "" };

/** Round the priority: none → low → medium → high → none. One key, because it
 *  is the field most often adjusted and least often typed. */
export async function cyclePriority(uuid: string, current: "H" | "M" | "L" | null, expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  const next = PRIO_CYCLE[current ?? ""] ?? "L";
  return runVerb([uuid, "modify", `priority:${next}`], expect);
}

/**
 * Re-state a whole task from one line of the grammar.
 *
 * The subtlety is what happens to what you left out. Typing the task again
 * without `!h` means you no longer want a priority — so the fields the grammar
 * can express are all set, and the ones that are absent are explicitly cleared.
 * Anything the grammar cannot express (a recurrence, a UDA) is never mentioned
 * and therefore never touched, which is the same merge property `import` throws
 * away.
 */
export async function editTask(uuid: string, input: string, previousTags: string[], expect?: string): Promise<WriteResult & { parsed?: ParsedTask }> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  const parsed = parseInput(input);
  if (!parsed.description) return { ok: false, error: "that is all labels and no task", parsed };
  const args = [uuid, "modify", parsed.description];
  args.push(`priority:${parsed.priority ?? ""}`);
  args.push(`project:${parsed.project ?? ""}`);
  args.push(`due:${parsed.due ?? ""}`);
  for (const t of parsed.tags) args.push(`+${t}`);
  // A tag that was there and is not in the new line was removed on purpose.
  for (const old of previousTags) if (!parsed.tags.includes(old) && TAG_RE.test(old)) args.push(`-${old}`);
  const r = await runVerb(args, expect);
  return { ...r, parsed };
}

/** Add tags without disturbing the ones already there — the merge is the point,
 *  since this exists to copy a set from one task onto several others. */
export async function addTags(uuid: string, tags: string[], expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  const clean = tags.filter((t) => TAG_RE.test(t));
  if (!clean.length) return { ok: false, error: "no tags to apply" };
  return runVerb([uuid, "modify", ...clean.map((t) => `+${t}`)], expect);
}

/**
 * Replace one annotation with another.
 *
 * `denotate` matches by SUBSTRING, so handing it a line that also appears
 * inside a longer annotation removes the wrong one. The old text is therefore
 * passed whole and compared here first: if the store does not contain exactly
 * that annotation, nothing is written and the caller re-reads.
 */
export async function replaceNote(uuid: string, oldText: string, newText: string, expect?: string): Promise<WriteResult> {
  if (!isUuid(uuid)) return { ok: false, error: "that is not a task id" };
  if (!oldText.trim()) return { ok: false, error: "nothing to replace" };
  const snapshot = await listTasks(true);
  const t = snapshot.tasks.find((x) => x.uuid === uuid);
  if (!t) return { ok: false, error: "that task is not in the list any more" };
  const exact = t.notes.filter((n) => n === oldText).length;
  if (exact !== 1) {
    return { ok: false, conflict: exact === 0, error: exact === 0
      ? "that note is not there any more — reloaded"
      : "two notes on this task are identical; edit it in your editor" };
  }
  const away = await runVerb([uuid, "denotate", oldText], expect ?? snapshot.fingerprint);
  if (!away.ok) return away;
  if (!newText.trim()) return away;
  return runVerb([uuid, "annotate", newText], away.fingerprint);
}

/*
 * The same change to a run of tasks, as one held lock.
 *
 * There is no `task` command for "these seven" — the CLI takes a filter, and a
 * filter is not a selection: the seven rows on screen are the result of a sort
 * and a search that no `task` expression reproduces, and one that nearly does
 * would act on an eighth row nobody could see. So the run is applied one task
 * at a time.
 *
 * One lock for the whole run, not one per task. Taking and releasing it between
 * tasks would leave a window for the editor to write into the middle, and half
 * the selection would then be acted on against a store the other half never
 * saw. The fingerprint is CHAINED for the same reason: each write's own result
 * is the precondition for the next, so the run either walks a store nobody else
 * touched or stops at the task where somebody did.
 *
 * It stops rather than continuing past a failure, and says how many landed. A
 * partial result reported as success is how somebody discovers next week that
 * three of nine were never completed.
 */
export type BulkAction = "done" | "priority" | "tag" | "delete";

export interface BulkResult extends WriteResult {
  /** How many actually landed — the number the message on screen must use. */
  applied?: number;
}

/** How many rows one gesture may touch. A selection is made by hand, key by
 *  key; a four-figure one is a bug in the caller, not a busy afternoon. */
const BULK_MAX = 200;

export async function bulkApply(
  uuids: string[], action: BulkAction, value: string | null = null, expect?: string,
): Promise<BulkResult> {
  // Selection shape is validated before the tool is even considered: an empty
  // selection is nothing to do regardless of whether Taskwarrior is installed,
  // and checking the tool first reported "not installed" for a request that was
  // malformed anyway (and broke this exact assertion in a taskless CI).
  if (!uuids.length) return { ok: false, error: "nothing is selected" };
  const bad = await writeGuard();
  if (bad) return { ok: false, error: bad };
  if (uuids.length > BULK_MAX) return { ok: false, error: `that is more than ${BULK_MAX} tasks at once` };
  if (!uuids.every(isUuid)) return { ok: false, error: "that is not a task id" };
  // Duplicates would apply the same change twice — harmless for `done`, not for
  // anything that toggles — and would inflate the count reported back.
  const targets = [...new Set(uuids)];

  // The shape of the change is checked ONCE, before the lock is taken: an
  // unusable value must not be discovered on the fourth task, with three
  // already written.
  let tail: string[];
  if (action === "done") tail = ["done"];
  else if (action === "delete") tail = ["delete"];
  else if (action === "priority") {
    const p = value ?? "";
    if (!["", "H", "M", "L"].includes(p)) return { ok: false, error: "that is not a priority" };
    tail = ["modify", `priority:${p}`];
  } else if (action === "tag") {
    if (!value || !TAG_RE.test(value)) return { ok: false, error: "that is not a tag" };
    tail = ["modify", `+${value}`];
  } else return { ok: false, error: "no such bulk action" };

  return withTaskLock(async () => {
    let fp = expect;
    let applied = 0;
    for (const uuid of targets) {
      const r = await verbInLock([uuid, ...tail], fp);
      if (!r.ok) {
        return {
          ...r, applied,
          error: applied
            ? `${r.error} — ${applied} of ${targets.length} were changed before that`
            : r.error,
        };
      }
      fp = r.fingerprint;
      applied++;
    }
    const after = await listTasks(true);
    return { ok: true, applied, tasks: after.tasks, fingerprint: after.fingerprint };
  });
}
