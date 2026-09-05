import type { UnderstudyFrame } from "../../../shared/types.ts";

/**
 * "The scorecard was recomputed" — one signal, every consumer.
 *
 * The understudy panel does not open a socket of its own, for the reason every
 * panel here does not: the app holds exactly one /stream connection, `useLive`
 * reads the frames off it, and a panel that opened a second would be a second
 * authentication, a second reconnect backoff and a second copy of the truth to
 * keep in step. So the frame arrives there and is announced here.
 *
 * A bus rather than a direct call into the store, and the difference is worth a
 * sentence: the store is one consumer that happens to exist today. The rail pip
 * that says "a class is being offered" is another, and it lives outside the
 * view — so the socket must be able to say the scorecard changed without
 * knowing who is listening. That is the same shape as gitBus, and it is the
 * shape for the same reason.
 *
 * Data rides along, unlike gitBus's bare nudge. The scorecard is pushed whole
 * (see UnderstudyFrame) rather than as a delta, so there is nothing for a
 * listener to go and re-read: the frame IS the answer, and making every
 * listener fetch it again would turn one push into N requests for a body the
 * client already holds.
 */
const listeners = new Set<(frame: UnderstudyFrame) => void>();

/** Called by the live socket when the server pushes a fresh scorecard. */
export function emitUnderstudy(frame: UnderstudyFrame): void {
  for (const fn of listeners) {
    try { fn(frame); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribeUnderstudyFrame(fn: (frame: UnderstudyFrame) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
