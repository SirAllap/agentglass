// The server watching its own event loop.
//
// This process is single-threaded and it carries the terminal. Every PTY byte
// the user types, and every byte the shell answers with, crosses a WebSocket
// served by the same loop that runs `git status`, parses `docker ps` and writes
// to SQLite. Anything that occupies that loop for 300ms is 300ms of a terminal
// that has stopped responding — and from the user's side it does not look like
// a slow endpoint, it looks like the app is broken.
//
// Finding those took a whole afternoon of bisecting with an external prober:
// ping a route that does no work, watch when the ping takes a second, guess
// what ran. This does it from the inside and keeps doing it, so the next one
// announces itself with the name of whatever was running.
//
// Deliberately in-memory and bounded, like the git command log: this is a live
// view of the current session, not an audit trail, and the value is entirely in
// the last few minutes.
//
// One line, past LOG_MS, also goes to disk (see stallTrace.ts): the ring dies
// with the process, and "no trace of why it froze" is exactly the bug a crash
// or a kill -9 must not reproduce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./childledger.ts";
import { appendStallLine } from "./stallTrace.ts";
import { runChild } from "./broker/brokerRun.ts";

/**
 * How often the heartbeat is supposed to fire.
 *
 * 250ms, down from 100. The tick is the whole cost of this file — ten timer
 * wakeups a second forever, in a process that idles at about 600 — and the
 * price of the coarser one is sampling: a block of B ms shows up as B minus the
 * time left to the next tick, so with a 250ms tick a 200ms stall is caught about
 * a third of the time where a 100ms tick caught four fifths. Blocks past ~370ms,
 * the ones that freeze a terminal for real, are always caught. Stalls between
 * STALL_MS and that are sampled now, not counted; a finer picture of those is the
 * next thing this does not do.
 */
const TICK_MS = 250;
/**
 * Drift past this counts as a stall. 120ms is roughly the point where typing
 * stops feeling immediate — under that, a keystroke still lands in the same
 * blink; over it, the echo is visibly late.
 */
const STALL_MS = 120;
/** Loud enough to reach the console, so it shows up in a bug report. */
const LOG_MS = 400;
/**
 * Ring size, overridable the way the git command log's is — so a test can prove
 * the trim in a second and a half instead of forty-six.
 *
 * Read per stall rather than at import: a module constant is fixed by whichever
 * file imports this first, which in a test run is whatever `bun test` happened
 * to load before the file doing the overriding. Stalls are rare by definition,
 * so an env read on each one costs nothing measurable.
 */
const cap = () => Number(process.env.AGENTGLASS_LOOPWATCH_SIZE ?? 200);

export interface Stall {
  id: number;
  at: number;
  /** How long the loop was unavailable, in ms. */
  ms: number;
  /** What was in flight when it stalled, if anything said so. */
  what: string;
  /** CPU the process burned across the stall, in ms. */
  cpuMs: number;
  /**
   * The thread was held without burning CPU: a synchronous read, a child
   * process waited on, or the machine not running us at all (swap, a stopped
   * process). Computing is this process's own code; waiting often is not.
   */
  waiting: boolean;
  /** Pages read back from disk during the stall — swap, on a machine short of memory. */
  majorFaults: number;
  /** Blocks read from disk rather than the page cache: a synchronous read, or SQLite, gone cold. */
  diskReads: number;
  /**
   * An unlabelled wait: the kernel's tally of where the main thread sat
   * ("kernel: S do_wait 3/5 (a child process)"). Its own field, never in
   * `what`, which stalls are grouped by: a count there made each one a group.
   */
  kernel?: string;
  /**
   * Unlabelled stalls only: the last label that finished and how long before
   * the stall began ("boot:x 12ms before the stall"). Its own field for the same
   * reason as `kernel`: a changing number in `what` would make each stall a group.
   */
  after?: string;
}

const ring: Stall[] = [];
let seq = 0;
/**
 * The most recent thing to start, and when.
 *
 * Not a stack of things "in flight", which is what this wanted to be: wrapping
 * a 400-line request handler in a callback to get an exact scope is a large,
 * risky edit to the one function that must never break, for precision this does
 * not need. A synchronous block runs to completion inside whatever entered
 * last, so the most recent label is the culprit — and a stall that arrives long
 * after anything entered is a timer or a stream pump, which the freshness
 * window below says outright rather than guessing.
 */
const BACKGROUND = "(background — a timer, a stream, or GC)";

/** The first frame of a stack, trimmed: where the loop was when it came back. */
export function topFrame(stack: string | undefined): string {
  const f = (stack ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("at "));
  return f ? f.slice(3) : "no frame";
}

/** The stack at this call site; the tick always asks from here, so its top frame never varies. */
function tickStack(): string | undefined { return new Error().stack; }

/** How an unlabelled stall is named: by the frame it was caught in, never blank. */
export function unlabelledWhat(stack: string | undefined, waiting = false, ownFrame = "", openBoot: readonly string[] = []): string {
  const frame = topFrame(stack);
  const head = unlabelledHead(openBoot);
  // The stack of a timer callback is the callback. When it is this watcher's own
  // tick, and the loop was waiting rather than computing, no JS was blocking:
  // the process was not scheduled (swap, disk, CPU contention). Say that
  // instead of pointing at the watcher, which was a false lead.
  // The compiled server has no file names (`/$bunfs/root/agentglass-server:3793:116`),
  // so the name test alone missed it there and a 1.9 s wait was filed as a JS
  // block at the watcher's own line. `ownFrame` is that frame, learned on a
  // tick that did not stall.
  if (waiting && (frame.includes("loopwatch") || (ownFrame !== "" && frame === ownFrame))) return `${head}: no JS was running (process waited on the OS: swap, disk or CPU)`;
  // The tick samples its own stack, so a computing stall reads "tickStack (…:LINE:COL)":
  // the watcher's own function, never the work that blocked it. A bundle position there
  // (5 installs, 5 different numbers) sent a hunt to the wrong place. Say what is known
  // instead: every boot step still open, since the last one opened is not always the one running.
  if (frame.startsWith("tickStack")) return `${head}: no JS frame (the watcher only sees itself)${openBoot.length > 1 ? `; open boot steps: ${openBoot.join(", ")}` : ""}`;
  return `${head}: ${frame}`;
}

/** "unlabelled", or "unlabelled (inside boot:x)" naming the last boot step started and not yet finished. */
export function unlabelledHead(openBoot: readonly string[]): string {
  const inside = openBoot[openBoot.length - 1];
  return inside ? `unlabelled (inside ${inside})` : "unlabelled";
}
/** A label, when it began, and when it answered (0 while still running). */
export interface Mark { what: string; at: number; done: number }
let recent: Mark | null = null;

/**
 * The label, carried across awaits — by hand.
 *
 * `recent` alone was a good heuristic while handlers were synchronous: a sync
 * handler runs to completion inside its own label, so "the last thing to start"
 * was the thing running. Once the expensive reads became async that stopped
 * being true. The blocking work is now a *continuation* that resumes long after
 * its handler returned, so "last to start" names whoever spoke most recently —
 * it named `/__ping__`, a route that does not exist and does nothing, for
 * 674ms. That is how this was caught.
 *
 * The right API for this is `async_hooks.createHook`, which reports when each
 * async resource begins and ends executing. Bun implements it as a no-op: init,
 * before and after never fire. `AsyncLocalStorage` is implemented and looked
 * like the answer, but `enterWith` proved unreliable once anything had entered
 * a store on the root context — the label came back undefined in exactly the
 * case this exists for, which is not something to build an instrument on.
 *
 * So: capture and restore, explicitly. A caller reads the label synchronously
 * at the moment it starts waiting — at which point it is standing inside the
 * right handler by construction — and hands it back when the continuation
 * resumes. Two function calls, no runtime magic, and it behaves the same in a
 * test as it does in production.
 */

/** The label to blame right now, for a caller about to await. */
/**
 * Whether the loop is already late — the heartbeat overdue by a stall's worth.
 *
 * A label entered then cannot have started the block: it is a request that
 * waited in the socket buffer while the loop was held, and whose handler ran
 * the moment it came back, before the heartbeat that measures the block. It
 * entered last and inside the window, and it did nothing. Measured on an
 * isolated server stopped from outside five times with no code at fault: all
 * five stalls were filed under `GET /health` or `POST /ingest`, whichever the
 * load happened to be sending. So a late label keeps the one before it.
 */
function late(): boolean {
  return timer !== null && performance.now() - last > TICK_MS + STALL_MS;
}

export function currentLabel(): string {
  return recent?.what ?? BACKGROUND;
}

/** "A continuation of `what` is about to run synchronously." */
export function resumedAs(what: string): void {
  if (late()) return;
  recent = { what, at: Date.now(), done: 0 };
}

/**
 * How far before the loop was last known free a label may have been entered
 * and still be blamed for the block that followed.
 *
 * This used to be two seconds from the stall being noticed, which quietly
 * libelled the cheapest endpoints in the app: `/gate/pending` reads an
 * in-memory Map in microseconds, is polled constantly, and was therefore the
 * most recent label whenever something else — GC, a stream pump, an async
 * continuation — stopped the loop. It came out top of the list at 600ms a call
 * for work it had already finished.
 *
 * A synchronous block runs inside whatever entered it, so the honest test is
 * whether the label was entered during the blocked period rather than merely
 * recently. The margin covers the gap between entering and starting to block.
 */
const BLAME_MARGIN_MS = 50;
let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let worst = 0;
let total = 0;
let started = 0;

/**
 * Name the work that is starting.
 *
 * The label is what a stall gets blamed on, so it should read like something a
 * human would recognise in a report: `GET /git/repos`, not `handler`. Cheap on
 * purpose — one object write — because this runs on every request including the
 * ones that must stay fast.
 */
export function entered(what: string): Mark {
  const mark = { what, at: Date.now(), done: 0 };
  if (!late()) recent = mark;
  return mark;
}

/**
 * The request answered. A label that ran for less than half a stall cannot
 * have caused it, even though it entered inside the window: under steady load
 * one always does. See the blame note in watchLoop.
 */
export function finished(mark: Mark): void {
  mark.done = Date.now();
  lastFinished = mark;
}

/** The last label to finish: what ran just before an unlabelled stall is the first suspect. */
let lastFinished: Mark | null = null;

/** "boot:x ended 12ms before the stall" (or "ended 40ms into it"); empty with nothing finished yet. */
export function afterNote(mark: Mark | null, stallStartedAt: number): string {
  if (!mark || !mark.done) return "";
  const d = Math.round(stallStartedAt - mark.done);
  return d >= 0 ? `after ${mark.what}, ended ${d}ms before the stall` : `after ${mark.what}, ended ${-d}ms into the stall`;
}

/**
 * Run a synchronous child wait under a label, so a stall during it is blamed
 * on the wait rather than on whatever `entered()` the loop last — see the
 * blame note in watchLoop. Label like "tmux list-panes": argv[0] plus the
 * command's first verb, not every flag.
 */
export function waitedFor<T>(label: string, run: () => T): T {
  const mark = entered(label);
  try {
    return run();
  } finally {
    finished(mark);
  }
}

/** How long a step that has not settled still counts as "inside" for stall attribution. */
export const BOOT_OPEN_MAX_MS = 60_000;
/** Boot steps that started and have not finished, oldest first. */
const openBoot: { label: string }[] = [];
/** The open boot steps, for tests and the stall line. */
export const openBootSteps = (): readonly string[] => openBoot.map((e) => e.label);

/**
 * One startup step, under a stable label "boot:<name>": a stall inside it is
 * named by it, and a stall in work it left running unlabelled is attributed to
 * it as "(inside boot:<name>)" until it finishes (a promise counts as running
 * until it settles). Same label mechanism as waitedFor; the step is unchanged.
 */
export function bootStep<T>(name: string, run: () => T, maxOpenMs = BOOT_OPEN_MAX_MS): T {
  const label = `boot:${name}`;
  // Each call owns one entry: closing by label would let an old call's timer close a newer step with the same label.
  const entry = { label };
  openBoot.push(entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { clearTimeout(timer); const i = openBoot.indexOf(entry); if (i >= 0) openBoot.splice(i, 1); };
  let r: T;
  try { r = waitedFor(label, run); } catch (e) { close(); throw e; }
  if (r && typeof (r as { then?: unknown }).then === "function") {
    // A promise that never settles must not name every later stall "(inside boot:x)" forever.
    timer = setTimeout(close, maxOpenMs);
    (timer as { unref?: () => void }).unref?.();
    (r as unknown as Promise<unknown>).then(close, close);
  }
  else close();
  return r;
}

/**
 * `setTimeout` whose callback runs under a label, so a stall inside it names
 * the job instead of falling to BACKGROUND. Same arguments, same handle back
 * (`.unref()` still works); the job itself is unchanged.
 */
export function setTimeoutAs<A extends unknown[]>(label: string, fn: (...a: A) => unknown, ms?: number, ...args: A): ReturnType<typeof setTimeout> {
  return setTimeout(() => { countFire(label); waitedFor(label, () => fn(...args)); }, ms);
}

/** How many times each labelled timer has fired: an idle server's count must stay bounded (see timers-bounded.test.ts). */
const fires = new Map<string, number>();
const countFire = (label: string) => { fires.set(label, (fires.get(label) ?? 0) + 1); };
export function timerFires(): Record<string, number> { return Object.fromEntries(fires); }

/** `setInterval` under a label — see setTimeoutAs. */
export function setIntervalAs<A extends unknown[]>(label: string, fn: (...a: A) => unknown, ms?: number, ...args: A): ReturnType<typeof setInterval> {
  return setInterval(() => { countFire(label); waitedFor(label, () => fn(...args)); }, ms);
}

/** `Bun.spawnSync` under a label: the wait on the child is the stall. */
export const spawnSyncAs = ((label: string, ...a: Parameters<typeof Bun.spawnSync>) =>
  waitedFor(label, () => (Bun.spawnSync as (...x: unknown[]) => unknown)(...a))) as unknown as
  { (label: string, ...a: Parameters<typeof Bun.spawnSync>): ReturnType<typeof Bun.spawnSync> & { stdout: Buffer; stderr: Buffer } };

/**
 * Whether a "stall" was the machine asleep rather than the loop held.
 *
 * performance.now() goes on counting while the machine is suspended in Bun on
 * Linux, so the first tick after a resume sees the whole sleep as drift: one
 * server logged "event loop blocked 219287314ms (3 ms CPU)", two and
 * a half days with the lid closed. The CPU clock does stop, which is what tells
 * the two apart: a held loop burns its own length when it computes and a
 * little when it waits on a read or a child, while a suspend burns nothing.
 *
 * Over a minute with under 1% of it in CPU is taken as a suspend. The ceiling
 * of that rule: a genuine synchronous wait longer than a minute that burns less
 * than 1% CPU is dropped with it. The longest real stall in two weeks of one
 * server's log was 50 s, so the minute sits above every one seen.
 */
export const SUSPEND_MIN_MS = 60_000;
export function suspended(ms: number, cpuMs: number): boolean {
  return ms > SUSPEND_MIN_MS && cpuMs < ms / 100;
}

/**
 * What the kernel says about memory stalls, as one short line: the avg10 of
 * `some` and `full` from /proc/pressure/memory. A stall that reads "waiting,
 * not computing" is the host paging; this says how hard, at that moment.
 * Empty when the file is missing (non-Linux, PSI off).
 */
export function pressureLine(text: string): string {
  const pick = (kind: string) => text.match(new RegExp(`^${kind} avg10=([0-9.]+)`, "m"))?.[1];
  const some = pick("some"), full = pick("full");
  return some && full ? `mem-pressure some=${some} full=${full}` : "";
}

/** The three biggest processes by resident memory, from `ps -eo rss=,comm=` output. */
export function topRss(ps: string): string {
  return ps.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.+)$/)).filter((m): m is RegExpMatchArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3)
    .map((m) => `${m[2]}=${Math.round(Number(m[1]) / 1024)}M`).join(" ");
}

/** Only a stall this long is worth a process listing; the listing is async so it cannot add to one. */
const WITNESS_MS = 1000;

/** avg10 of `some` from one /proc/pressure file, as `io=1.32`; empty when absent. */
export function somePressure(kind: string, text: string): string {
  const v = text.match(/^some avg10=([0-9.]+)/m)?.[1];
  return v ? `${kind}=${v}` : "";
}

/** How the stall itself looked, for the log line: a held loop burns its own
 *  length in CPU, a waiting one (disk, lock, child, scheduler) burns almost
 *  none. Measured on this server's own log, 868 of 953 stalls over 1.5 s were
 *  waiting, with tens of ms of CPU inside seconds, so a stall with no cause in
 *  the code is not a stall to fix by moving compute off the loop. The file used
 *  to keep only the label, which made that split invisible once the console
 *  line scrolled away. */
export function stallDetail(s: { cpuMs: number; waiting: boolean; majorFaults: number; diskReads: number }): string {
  return [s.waiting ? "waiting" : "computing", `cpu=${s.cpuMs}ms`, s.majorFaults ? `swapin=${s.majorFaults}` : "", s.diskReads ? `diskblk=${s.diskReads}` : ""].filter(Boolean).join(" ");
}

function witness(ms: number): void {
  let pressure = "";
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  try { pressure = [pressureLine(read("/proc/pressure/memory")), somePressure("io", read("/proc/pressure/io")), somePressure("cpu", read("/proc/pressure/cpu"))].filter(Boolean).join(" "); } catch { /* no PSI */ }
  const write = (top: string) => appendStallLine(join(stateDir(), "server-stall.log"),
    `${new Date().toISOString()}   after ${ms}ms: ${[pressure, top && `top-rss ${top}`].filter(Boolean).join(" ")}\n`);
  try {
    // In the broker (broker/brokerRun.ts): a stall is the worst moment to fork this server.
    void runChild(["ps", "-eo", "rss=,comm="], { timeoutMs: 5_000, read: true })
      .then((r) => write(topRss(r.stdout)), () => write(""));
  } catch { write(""); }
}

// --- what the kernel says the main thread is waiting on ------------------------
//
// 203 of the 222 stalls over 1 s logged on 2026-11-13 read "unlabelled: no JS
// was running": no request, timer or child wait was labelled, and CPU was about
// 14% of the stall. 73 of them came with memory pressure under 0.1, so swap is
// not the whole story. The JS side cannot say more: while the thread is held,
// nothing on it runs. The kernel can. /proc/<pid>/task/<pid>/wchan names the
// kernel function the main thread is asleep in, and stat says how (D: disk, S:
// sleep, R: runnable but not on a CPU). That is how the 15 h study behind
// `synchronous = NORMAL` in db.ts found write_all_supers and folio_wait_bit.
//
// So a small worker thread (about 9 MB RSS, measured) looks at the main thread,
// and only while the heartbeat below is late: it reads one int every
// SAMPLE_EVERY_MS and touches /proc only mid-stall. The tally goes back through
// a SharedArrayBuffer, because a message would arrive after the tick that
// reports the stall. The worker source is a string for the same reason the
// checkpointer's is: `bun build --compile` does not carry a second file.
const SAMPLE_EVERY_MS = 200;
/** A heartbeat older than this means the main thread is held right now. */
const LATE_MS = 450;
/** [0] heartbeat (Date.now() & 0x7fffffff), [1] bytes of tally text; then the text. */
const SAMPLE_BYTES = 512;
const SAMPLER = `const S=${SAMPLE_EVERY_MS},L=${LATE_MS},M=${SAMPLE_BYTES - 8};
import { readFileSync } from "node:fs";
self.onmessage = (e) => {
  const { sab, pid } = e.data, h = new Int32Array(sab, 0, 2), out = new Uint8Array(sab, 8), enc = new TextEncoder();
  const base = "/proc/" + pid + "/task/" + pid + "/";
  let tally = new Map(), n = 0;
  setInterval(() => {
    const age = ((Date.now() & 0x7fffffff) - Atomics.load(h, 0)) & 0x7fffffff;
    if (age < L) { if (n) { tally = new Map(); n = 0; } return; }
    let key = "?";
    try {
      const st = readFileSync(base + "stat", "utf8"), state = st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3);
      const w = readFileSync(base + "wchan", "utf8").trim();
      key = state + " " + (w && w !== "0" ? w : "-");
    } catch {}
    tally.set(key, (tally.get(key) || 0) + 1); n++;
    const text = [...tally].sort((a, b) => b[1] - a[1]).map(([k, c]) => k + " " + c + "/" + n).join(", ");
    const b = enc.encode(text).slice(0, M); out.set(b); Atomics.store(h, 1, b.length);
  }, S);
};`;
let sampler: Worker | null = null;
let sampleBuf: Int32Array | null = null;
let sampleText: Uint8Array | null = null;

/** Plain words for the kernel waits seen on this machine; the raw name stays beside them. */
const WCHAN_MEANS: [RegExp, string][] = [
  [/^folio_wait|^wait_on_page|^filemap_fault|^do_swap_page|^swap_/, "a page read from disk or swap"],
  [/^write_all_supers|^btrfs_|^jbd2|^wait_current_trans|^wait_for_commit|^file_write_and_wait|^do_fsync/, "an fsync behind a filesystem commit"],
  [/^do_wait$/, "a child process the loop waited for"],
  [/^futex/, "a lock held by another thread (GC, sqlite, a worker)"],
  [/^pipe_|^unix_stream|^wait_woken|^sk_wait/, "a pipe or socket read with nothing to read"],
  [/^ep_poll|^do_epoll/, "the loop's own idle wait"],
  [/^rwsem|^mutex|^rt_mutex|^down_/, "a kernel lock (mmap_lock under paging, an inode)"],
];
/** `D folio_wait_bit 4/5` -> the same, plus what it means when we know. */
export function explainKernelWait(tally: string): string {
  const first = tally.split(", ")[0] ?? "";
  const [state, wchan] = first.split(" ");
  if (state === "R") return `kernel: ${tally} (runnable, waiting for a CPU)`;
  const means = WCHAN_MEANS.find(([re]) => re.test(wchan ?? ""))?.[1];
  return `kernel: ${tally}${means ? ` (${means})` : ""}`;
}

/** The tally since the last call, and clear it. Empty when the main thread was never late. */
function takeKernelWait(): string {
  if (!sampleBuf || !sampleText) return "";
  const len = Atomics.load(sampleBuf, 1);
  if (!len) return "";
  Atomics.store(sampleBuf, 1, 0);
  return new TextDecoder().decode(sampleText.slice(0, len));
}

function startSampler(): void {
  if (sampler || process.platform !== "linux" || process.env.AGENTGLASS_STALL_SAMPLER === "0") return;
  try {
    const sab = new SharedArrayBuffer(SAMPLE_BYTES);
    sampleBuf = new Int32Array(sab, 0, 2);
    sampleText = new Uint8Array(sab, 8);
    Atomics.store(sampleBuf, 0, Date.now() & 0x7fffffff);
    const w = new Worker(URL.createObjectURL(new Blob([SAMPLER], { type: "application/javascript" })));
    w.postMessage({ sab, pid: process.pid });
    w.unref?.();
    sampler = w;
  } catch { sampler = null; sampleBuf = null; sampleText = null; }
}

export function watchLoop(): void {
  if (timer) return;
  started = Date.now();
  last = performance.now();
  let usage = process.resourceUsage();
  let ownFrame = "";
  startSampler();
  timer = setInterval(() => {
    const now = performance.now();
    if (sampleBuf) Atomics.store(sampleBuf, 0, Date.now() & 0x7fffffff);
    const kernel = takeKernelWait();
    if (!ownFrame) ownFrame = topFrame(tickStack());
    const drift = now - last - TICK_MS;
    const was = usage;
    usage = process.resourceUsage();
    // When the loop was last known free. Everything that entered since then is
    // a candidate for having blocked it — see the blame note below.
    const freeAt = Date.now() - Math.round(now - last);
    last = now;
    if (drift < STALL_MS) return;
    const ms = Math.round(drift);
    // Process-wide CPU, not the main thread's: the other threads (GC, sqlite)
    // are mostly idle, and a block this long on the main thread burns its own
    // length in CPU, so half of it is a wide margin either way.
    const cpuMs = Math.round((usage.userCPUTime + usage.systemCPUTime - was.userCPUTime - was.systemCPUTime) / 1000);
    if (suspended(ms, cpuMs)) return;
    total += ms;
    if (ms > worst) worst = ms;
    // Whatever was on the stack when the loop came back is the best witness we
    // have. Empty means the culprit was not wrapped — a timer, a stream pump,
    // or GC — which is itself worth knowing.
    // Blame anything that entered since the loop was last free.
    //
    // NOT `now - drift`, which is the tick's *expected* time rather than the
    // moment work actually began: a task that starts just after a tick and
    // blocks for 300ms is reported as 210ms of drift, and dating the block from
    // `now - 210` places its start 90ms after the task began — so the task that
    // did it looks too old to be responsible and the stall is filed under
    // "background". Which is exactly what happened, and what this comment is
    // paid for.
    const quick = !!recent?.done && recent.done - recent.at < ms / 2;
    const waiting = cpuMs < ms / 2;
    const labelled = recent && !quick && recent.at >= freeAt - BLAME_MARGIN_MS ? recent.what : "";
    // Unlabelled and waiting, the kernel's view is the only witness there is:
    // keep it beside the name, not in it. Not when computing: the thread is
    // then on a CPU running JS, and "R" would read as CPU starvation.
    const what = labelled || unlabelledWhat(tickStack(), waiting, ownFrame, openBootSteps());
    const kernelWhy = !labelled && waiting && kernel ? explainKernelWait(kernel) : "";
    const after = labelled ? "" : afterNote(lastFinished, freeAt);
    const majorFaults = usage.majorPageFault - was.majorPageFault;
    const diskReads = usage.fsRead - was.fsRead;
    const entry: Stall = { id: ++seq, at: Date.now(), ms, what, cpuMs, waiting, majorFaults, diskReads, ...(kernelWhy ? { kernel: kernelWhy } : {}), ...(after ? { after } : {}) };
    ring.push(entry);
    const max = cap();
    if (ring.length > max) ring.splice(0, ring.length - max);
    if (ms >= LOG_MS) {
      const how = waiting
        ? `waiting, not computing (${[`${cpuMs}ms CPU`,
            majorFaults ? `${majorFaults} pages read back from swap` : "",
            diskReads ? `${diskReads} blocks read from disk` : ""].filter(Boolean).join(", ")})`
        : "computing";
      const by = [what, after, kernelWhy].filter(Boolean).join(" — ");
      console.warn(`⏱  event loop blocked ${ms}ms by ${by}, ${how} — the terminal was frozen for that long`);
      appendStallLine(join(stateDir(), "server-stall.log"), `${new Date().toISOString()} server stall ms=${ms} last=${by} ${stallDetail(entry)}\n`);
      if (ms >= WITNESS_MS) witness(ms);
    }
  }, TICK_MS);
  // Never hold the process open for this.
  timer.unref?.();
}

// --- load shedding -----------------------------------------------------------
//
// Knowing the loop is drowning is worth something; doing nothing about it is
// worth less than it sounds. Everything in this process competes for one
// thread, and the terminal loses by accident — it is the only participant whose
// delay a human feels directly, and it has no way to ask for priority.
//
// So it gets one. Two signals make the background work stand back, and both are
// facts rather than guesses:
//
//   * Someone is typing. A keystroke arriving at a PTY is the least ambiguous
//     "a human is waiting on this process right now" signal available. The
//     dirty dots in a dropdown can be four seconds older than usual; the echo
//     of a keystroke cannot be late.
//   * The loop is already stalling. If something blocked it 500ms in the last
//     ten seconds, adding a `git status` sweep on top is the wrong instinct.
//
// The effect is a multiplier on how long the background caches hold, which is
// all the machinery this needs: those TTLs already exist, they are already the
// only thing deciding how often the expensive sweeps run, and multiplying them
// degrades to "slightly staler panel" rather than to a broken one. It recovers
// on its own the moment both signals go quiet — nothing to reset, nothing that
// can get stuck shedding.

/** How long after a keystroke the terminal still counts as in use. */
const HOT_MS = 4_000;
/**
 * The window pressure is judged over, and the budget inside it.
 *
 * The window is env-overridable for the same reason the ring size is: a test
 * that has to wait ten real seconds for a stall to age out is a test nobody
 * runs. Read per call, not at import.
 */
const pressureWindow = () => Number(process.env.AGENTGLASS_PRESSURE_WINDOW_MS ?? 10_000);
const PRESSURE_BUDGET_MS = 400;
/** How far the background is pushed back when either signal fires. Deliberately
 *  modest: this is a step back, not a strike. */
const HOT_FACTOR = 3;
const PRESSURE_FACTOR = 4;

let lastKeystroke = 0;

/** Called on every byte a user sends to a shell. Cheap by necessity — it runs
 *  on the hot path of the one thing this is protecting. */
export function terminalActive(): void {
  lastKeystroke = Date.now();
}

/** Is a human typing into a shell right now? */
export function terminalHot(): boolean {
  return Date.now() - lastKeystroke < HOT_MS;
}

/** Milliseconds the loop was unavailable inside the recent window. */
export function pressureMs(): number {
  const from = Date.now() - pressureWindow();
  let n = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].at < from) break;
    n += ring[i].ms;
  }
  return n;
}

/**
 * Multiply a background cache's lifetime by this.
 *
 * 1 when the app is calm, which is almost always — a user reading a diff is not
 * typing and is not stalling anything, and nothing about their panels should
 * change. The two are not added together: the worst signal wins, because
 * doubling up on a bad moment is how a "protection" turns into a panel that
 * never refreshes.
 */
export function backoff(): number {
  return Math.max(
    1,
    terminalHot() ? HOT_FACTOR : 1,
    pressureMs() > PRESSURE_BUDGET_MS ? PRESSURE_FACTOR : 1,
  );
}

/** Stalls newer than `since` (an id), oldest first, plus the running totals. */
export function stalls(since = 0): { stalls: Stall[]; worstMs: number; totalMs: number; sinceMs: number; backoff: number; terminalHot: boolean } {
  const out = since > 0 ? ring.filter((e) => e.id > since) : ring.slice();
  return {
    stalls: out, worstMs: worst, totalMs: total,
    sinceMs: started ? Date.now() - started : 0,
    // Reported, so "why is the docker panel slow to update" has an answer that
    // is not a shrug: it is standing back because you are typing.
    backoff: backoff(), terminalHot: terminalHot(),
  };
}
