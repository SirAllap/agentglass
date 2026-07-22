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

/** How often the heartbeat is supposed to fire. */
const TICK_MS = 100;
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
let recent: { what: string; at: number } | null = null;
/** Past this, the last-entered label is no longer a plausible witness. */
const FRESH_MS = 2_000;
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
export function entered(what: string): void {
  recent = { what, at: Date.now() };
}

export function watchLoop(): void {
  if (timer) return;
  started = Date.now();
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - TICK_MS;
    last = now;
    if (drift < STALL_MS) return;
    const ms = Math.round(drift);
    total += ms;
    if (ms > worst) worst = ms;
    // Whatever was on the stack when the loop came back is the best witness we
    // have. Empty means the culprit was not wrapped — a timer, a stream pump,
    // or GC — which is itself worth knowing.
    const what = recent && Date.now() - recent.at < FRESH_MS ? recent.what : "(background — a timer, a stream, or GC)";
    const entry: Stall = { id: ++seq, at: Date.now(), ms, what };
    ring.push(entry);
    const max = cap();
    if (ring.length > max) ring.splice(0, ring.length - max);
    if (ms >= LOG_MS) {
      console.warn(`⏱  event loop blocked ${ms}ms by ${what} — the terminal was frozen for that long`);
    }
  }, TICK_MS);
  // Never hold the process open for this.
  timer.unref?.();
}

/** Stalls newer than `since` (an id), oldest first, plus the running totals. */
export function stalls(since = 0): { stalls: Stall[]; worstMs: number; totalMs: number; sinceMs: number } {
  const out = since > 0 ? ring.filter((e) => e.id > since) : ring.slice();
  return { stalls: out, worstMs: worst, totalMs: total, sinceMs: started ? Date.now() - started : 0 };
}
