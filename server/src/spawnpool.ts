// A ceiling on how many subprocesses this server has in flight at once.
//
// Making the git and docker reads concurrent fixed the freezes and created a
// different failure: nothing bounded the fan-out. A cold `/git/repos` is ~36
// processes on a repo with eighteen checkouts, `/git/worktrees` another ~60,
// and a panel that opens both at once — or a client that retries while they are
// still running — multiplies that again. Driven hard, the sidecar stopped
// answering entirely: not slow, gone. Concurrency without a limit is a fork
// bomb with good intentions.
//
// So every awaited spawn goes through here. The limit is per process and
// global, not per caller, because the resources being protected — file
// descriptors, pids, memory, the machine's patience — are shared by all of
// them. Work over the limit waits its turn instead of being refused: a slower
// dirty count is fine, a dead server is not.
//
// What this does NOT fix, measured rather than assumed: driving five expensive
// endpoints three times over concurrently still saturates the server — a route
// that does no work answers in ~700ms while the backlog drains. That is sixteen
// subprocesses' worth of pipe traffic on one thread, and it is real work rather
// than a stall; the app's own polls are seconds apart and never approach it.
// Handing the freed slot to the next waiter through a timer instead of inline
// was tried, on the theory that a chain of microtasks was starving I/O, and
// measured no better — so it is not here.
//
// Deliberately not applied to the synchronous `git()` helper. That one holds
// the event loop for its whole duration, so the loop itself already guarantees
// one at a time — and the goal is to delete those, not to queue them.

/**
 * How many at once.
 *
 * Sized off the machine rather than guessed: the work is process spawns, which
 * are CPU- and syscall-bound, and leaving a couple of cores for the server
 * itself (and for the shell the user is typing into, which is the whole point)
 * is what keeps the app responsive while a sweep runs. Bounded on both sides so
 * a single-core box still makes progress and a 64-core one does not decide that
 * 62 concurrent `git status` calls is a good idea.
 *
 * Read per call rather than fixed at import, for the same reason the watchdog's
 * ring size is: a module constant is decided by whichever file imports this
 * first, which in a test run is never the file doing the overriding.
 */
const limit = () => Math.max(
  4,
  Math.min(16, Number(process.env.AGENTGLASS_SPAWN_LIMIT) || navigator.hardwareConcurrency - 2),
);

let inflight = 0;
const waiting: (() => void)[] = [];
/** High-water marks, so `/api/loopwatch` can say whether the cap is biting. */
let peakInflight = 0;
let peakWaiting = 0;

/**
 * Run `fn` when there is room, and give the slot back however it ends.
 *
 * The `finally` is the whole contract: a spawn that throws — no such binary, a
 * killed child, a torn-down stream — must not leak its slot, or the pool drains
 * to zero over a long session and the app quietly stops being able to run git
 * at all. That failure would look exactly like the freeze this replaced, which
 * is why it is worth saying out loud.
 */
export async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inflight >= limit()) {
    if (waiting.length + 1 > peakWaiting) peakWaiting = waiting.length + 1;
    await new Promise<void>((release) => waiting.push(release));
  }
  inflight++;
  if (inflight > peakInflight) peakInflight = inflight;
  try {
    return await fn();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

export function spawnPoolStats(): { limit: number; inflight: number; waiting: number; peakInflight: number; peakWaiting: number } {
  return { limit: limit(), inflight, waiting: waiting.length, peakInflight, peakWaiting };
}
