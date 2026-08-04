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
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withSpawnSlot } from "./spawnpool.ts";
import { singleFlight } from "./singleflight.ts";
import { entered, backoff, resumedAs, currentLabel } from "./loopwatch.ts";
import type { TaskCapability, LocalTask } from "../../shared/types.ts";

export type TaskResult = { code: number; stdout: string; stderr: string; killed?: boolean };

/**
 * Is `task` even here?
 *
 * `Bun.spawn` throws on a missing binary rather than returning 127, so without
 * this the panel would invent a cause for a machine that simply has no
 * Taskwarrior. Same first-class-state treatment `gitBin`/`ghCapability` give
 * their tools. PATH passed explicitly, for the reason `git.ts:97` gives.
 */
let binCache: string | null | undefined;
export function taskBin(): string | null {
  if (binCache === undefined) binCache = Bun.which("task", { PATH: process.env.PATH ?? "" });
  return binCache;
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
/** Test seam. */
export function __resetTaskPaths(): void { paths = null; }

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

/** A cheap stand-in for "did anything change" — length plus the uuids and their
 *  modification-sensitive fields, hashed by the runtime. Compared by the sweep
 *  so a poll that found nothing new costs one broadcast fewer. */
const fingerprintOf = (raw: string) => String(Bun.hash(raw));

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
