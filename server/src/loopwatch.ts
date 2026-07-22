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
const BACKGROUND = "(background — a timer, a stream, or GC)";
let recent: { what: string; at: number } | null = null;

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
export function currentLabel(): string {
  return recent?.what ?? BACKGROUND;
}

/** "A continuation of `what` is about to run synchronously." */
export function resumedAs(what: string): void {
  recent = { what, at: Date.now() };
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
    // When the loop was last known free. Everything that entered since then is
    // a candidate for having blocked it — see the blame note below.
    const freeAt = Date.now() - Math.round(now - last);
    last = now;
    if (drift < STALL_MS) return;
    const ms = Math.round(drift);
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
    const what = recent && recent.at >= freeAt - BLAME_MARGIN_MS ? recent.what : BACKGROUND;
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
