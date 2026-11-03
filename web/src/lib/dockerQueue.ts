/*
 * One overview fetch at a time, and never a request dropped.
 *
 * Events arrive in bursts — stopping a project is one `die` per container — and
 * a fetch already on the wire cannot see anything that happened after it
 * started. So a request that lands during a fetch must still own the run after
 * it. The first version queued only a `fresh` one, so every event that arrived
 * mid-fetch was thrown away; after a stop of eleven containers the last event
 * went missing and the list drew them all as running until the panel was
 * rebuilt.
 */
export type Refetch = (fresh?: boolean) => Promise<void>;

export function coalescing(run: (fresh: boolean) => Promise<void>): Refetch {
  let inflight: Promise<void> | null = null;
  /** A request that arrived while one was running: one more run, never more. */
  let again: { fresh: boolean } | null = null;

  return (fresh = false) => {
    if (inflight) {
      again = { fresh: (again?.fresh ?? false) || fresh };
      return inflight;
    }
    const start = { fresh: fresh || (again?.fresh ?? false) };
    const loop = (async () => {
      let next: { fresh: boolean } | null = start;
      while (next) {
        again = null;
        await run(next.fresh);
        next = again;
      }
    })().finally(() => { inflight = null; });
    inflight = loop;
    return loop;
  };
}
