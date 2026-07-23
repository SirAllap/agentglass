// Collapse concurrent identical work into one computation.
//
// The panels poll, and the app is built to be left open across several tabs and
// a desktop window at once — every one of them asking the same server the same
// questions on the same timers. When two of those land in the same instant, the
// caching in front of each endpoint does not save them: a TTL that has just
// expired, or a refs-fingerprint that has to be read before the cache can even
// be consulted, is recomputed by *each* caller independently. On the git reads
// that is a fan-out of `git status`/`for-each-ref`/`worktree list` subprocesses
// — measured pinning the spawn pool at its cap with hundreds queued behind it,
// on the one thread that also carries the terminal's PTY. The keystroke echo
// went from ~10ms to seconds.
//
// This is the missing half of the caching story. A cache reuses an answer
// *across time*; this reuses one *across callers who overlap in time*. The
// first caller for a key starts the work and every caller that arrives while it
// is still running gets the very same promise — one subprocess sweep, N
// readers. The entry is dropped the moment it settles, so this is not a cache
// and holds nothing stale: a caller that arrives after the work finished starts
// fresh (and hits whatever real cache sits behind it). It only ever removes
// duplicate *simultaneous* work, which is exactly the stampede the polling
// fan-out creates and nothing the per-endpoint caches were ever going to catch.
//
// Correctness is trivial by construction: the shared callers asked the identical
// question at the same moment, so one answer is every answer. An error rejects
// all of them — as it would have for each separately — and clears the entry, so
// a failure is never memoised.

const inflight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` once for `key` even if called many times concurrently; every caller
 * in the same window shares the one result. The entry is released as soon as
 * the work settles (success or failure), so this dedupes only overlapping work
 * and never serves a stale value.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  // Start the work, and guarantee the map is cleaned up however it ends —
  // a leaked entry would pin one answer forever, which is worse than the
  // duplicate work this removes. The entry for `key` is only ever set below,
  // and only when none was present, so the one this deletes is always the one
  // it created: an unconditional delete is correct on this single thread. The
  // delete runs before any awaiter's `.then`, so the next arrival after settle
  // always starts a fresh computation.
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** How many distinct computations are being shared right now. Exposed for the
 *  loop watchdog / tests, so "the fan-out collapsed" is observable, not assumed. */
export function inflightCount(): number {
  return inflight.size;
}
