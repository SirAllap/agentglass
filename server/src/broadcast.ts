/*
 * Fan-out to every open client, written so one client that stopped draining
 * can never cost the others a blocked event loop.
 *
 * `ws.send()` queues onto the socket's own buffer rather than blocking; the
 * failure mode this guards against is that queue growing without bound while
 * a client sits there not reading (a backgrounded tab, a frozen peer, a dead
 * connection the TCP stack has not noticed yet). Left alone that queue is
 * exactly the kind of memory growth that ends in a major page fault — the
 * loop watchdog's "waiting, not computing, N pages read back from swap" is
 * that cost landing on whichever broadcast happened to be running at the
 * time, not on the client that caused it.
 *
 * The fix is to stop feeding a client once its own buffer is already full
 * rather than to make the write itself smarter: a frame skipped this way is
 * not a bug PROVIDED the client finds out — see `missedSince` below — because
 * every client resyncs from `initial` on reconnect (web/src/lib/useLive.ts:187
 * reconnects on `onclose` and index.ts's `open()` handler sends a fresh
 * `initial` frame to every new socket).
 *
 * A client skipped once and then found caught up MUST NOT just resume silently:
 * it missed a frame, so whatever it is holding is stale, and nothing else ever
 * tells it that. Closing it the moment it drains (or at `STALL_CLOSE_MS`,
 * whichever comes first) is what forces the reconnect that actually fixes it.
 */

export const BACKPRESSURE_HIGH_WATER = 1024 * 1024; // 1MB queued and not draining
export const STALL_CLOSE_MS = 30_000; // how long a client may sit over the mark before we give up on it

export interface BroadcastSocket {
  send(data: string): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

/** When a socket first went over the mark. Present only between that moment
 *  and the close that always follows it — either once it drains or at
 *  STALL_CLOSE_MS, never both. */
const missedSince = new WeakMap<BroadcastSocket, number>();

/**
 * Send `msg` to every socket in `clients` that is keeping up. One that is
 * not gets this frame skipped rather than queued onto it; the first time
 * that happens it is marked, and the mark is what turns into a close — the
 * instant it drains, or at `STALL_CLOSE_MS` if it never does — so it always
 * reconnects rather than silently sitting on a gap. `onDrop` is how the
 * caller removes a closed or throwing socket from its own client set — this
 * module holds no such set itself.
 */
export function broadcastTo<T extends BroadcastSocket>(
  clients: Iterable<T>,
  msg: string,
  onDrop: (ws: T) => void,
  now: () => number = Date.now,
): void {
  const at = now();
  for (const ws of clients) {
    const buffered = ws.getBufferedAmount();
    const missedAt = missedSince.get(ws);

    if (buffered <= BACKPRESSURE_HIGH_WATER) {
      if (missedAt !== undefined) {
        // Caught up, but it already missed a frame while it was stuck.
        // Resuming quietly would leave it holding a permanent gap — close it
        // so it reconnects and pulls a fresh `initial` instead.
        missedSince.delete(ws);
        try { ws.close(1008, "missed a broadcast"); } catch { /* already gone */ }
        onDrop(ws);
        continue;
      }
      try {
        ws.send(msg);
      } catch {
        onDrop(ws);
      }
      continue;
    }

    // Over the mark: skip this frame rather than queue onto it.
    if (missedAt === undefined) {
      missedSince.set(ws, at);
    } else if (at - missedAt > STALL_CLOSE_MS) {
      missedSince.delete(ws);
      try { ws.close(1008, "not draining"); } catch { /* already gone */ }
      onDrop(ws);
    }
  }
}
