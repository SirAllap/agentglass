/*
 * PTY bytes, gathered into one crossing of the bridge instead of two hundred.
 *
 * ── the cost this exists to stop ─────────────────────────────────────────
 * Every chunk that arrives on the socket used to become its own
 * `injectJavaScript` call: a string evaluated by the WebView, a `term.write`,
 * and whatever repaint that caused. A busy pane is not a trickle — `yarn
 * build`, a test run, `cat` of anything — and each of those frames paid the
 * full price of the RN↔WebView bridge on the way in.
 *
 * The bridge is the expensive half. xterm is fast at parsing a large buffer and
 * slow at being called two hundred times, because the per-call cost is a
 * serialised string crossing a process boundary and an `eval` on the other
 * side. Joining the frames that arrive inside one window turns two hundred
 * crossings a second into about twenty, with the SAME bytes arriving in the
 * same order.
 *
 * ── why 48ms ─────────────────────────────────────────────────────────────
 * About 20Hz. Under a frame and a half at 60Hz, so a person watching output
 * scroll cannot see the batching; far enough above the per-call cost that a
 * flood collapses into a handful of writes. Typing is unaffected because
 * typing does not come through here — keystrokes go the other way.
 *
 * ── the leading edge is the point ────────────────────────────────────────
 * The first chunk after a quiet period is delivered IMMEDIATELY, not 48ms
 * later. That chunk is almost always the echo of a key somebody just pressed,
 * and a terminal that shows your own typing an eyeblink late feels broken in
 * exactly the way this is meant to fix. Only the frames that arrive DURING the
 * window are held, and they are the ones nobody is reading individually.
 *
 * ── and why there is a cap ───────────────────────────────────────────────
 * Defence in depth. If the far end never stops, the buffer must not grow until
 * the process dies — so past the cap it flushes at once rather than waiting for
 * the timer. That trades the batching back for a bound, which is the right way
 * round: a slow terminal is a complaint, a killed one is a lost session.
 */

/** About 20Hz. See the note above — it is a frame and a half, not a guess. */
export const FLUSH_MS = 48;

/** Roughly a screen of dense output many times over. Past this the window is
 *  abandoned and everything held goes now. */
export const MAX_PENDING = 256 * 1024;

export interface Coalescer {
  /** A chunk from the socket, base64 exactly as it arrived. */
  push: (chunk: string) => void;
  /** Send anything held, now. Called when the pane changes or the view goes
   *  away — a buffer belonging to a pane nobody is looking at must not be
   *  delivered to the next one. */
  flush: () => void;
  /** Throw away what is held without delivering it, and stop the timer. */
  clear: () => void;
  /** For tests and for the view's teardown. */
  pending: () => number;
}

/**
 * `deliver` is handed the chunks in arrival order.
 *
 * An array rather than a joined string, because base64 frames cannot be
 * concatenated and still decode — each one is its own quantum, and the page's
 * `write` takes them one at a time. What is saved is the CROSSING, not the
 * decode: one injection carrying twelve frames costs one bridge trip.
 */
export function createCoalescer(
  deliver: (chunks: string[]) => void,
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
): Coalescer {
  let held: string[] = [];
  let units = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Starts expired, so the very first chunk takes the leading edge rather than
   *  waiting for a window that has never opened. */
  let lastAt = Number.NEGATIVE_INFINITY;

  const stop = (): void => {
    if (timer !== null) { cancel(timer); timer = null; }
  };

  const send = (): void => {
    stop();
    if (!held.length) return;
    const out = held;
    held = [];
    units = 0;
    lastAt = now();
    deliver(out);
  };

  return {
    push(chunk: string): void {
      if (!chunk) return;
      held.push(chunk);
      units += chunk.length;

      // Past the cap, the window is over — bound beats batch.
      if (units >= MAX_PENDING) { send(); return; }

      const since = now() - lastAt;
      if (since >= FLUSH_MS) { send(); return; }

      // Inside the window. One timer for the whole window, not one per chunk:
      // rearming on every arrival is how a steady stream never flushes at all.
      if (timer === null) timer = schedule(send, FLUSH_MS - since);
    },
    flush: send,
    clear(): void {
      stop();
      held = [];
      units = 0;
      // Deliberately NOT resetting `lastAt`: a pane swap should not hand the
      // next pane a delayed first frame. It re-arms on the next send.
    },
    pending: () => held.length,
  };
}
