/**
 * How many daemon-spawning reads one credential may have in flight.
 *
 * The docker slow lane answers a GET by starting a process — `docker inspect`,
 * a throwaway container for a volume peek — and a GET is a read. spawnpool.ts
 * already bounds how many run at once machine-wide, but it queues the rest, and
 * the queue is shared: a paired read-only phone or a read plugin asking for a
 * hundred filled it, and the desk's own git and docker reads waited behind
 * them. This is the other half — a refusal, per credential, before the queue.
 * The desk is not counted: it holds the machine token, and a cap on it would
 * only ever slow the owner down.
 *
 * Per credential rather than global, so one runaway phone cannot starve
 * another. The ceiling is concurrency, not rate: a caller that waits for each
 * answer can still ask forever, one at a time, which is what the panel does.
 */
export const SPAWN_CAP = 4;

const inFlight = new Map<string, number>();

/** A slot for `key`, as the function that gives it back, or null when full.
 *  The release is idempotent: a stream that both ends and aborts frees one. */
export function takeSpawnSlot(key: string, cap = SPAWN_CAP): (() => void) | null {
  const n = inFlight.get(key) ?? 0;
  if (n >= cap) return null;
  inFlight.set(key, n + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };
}
