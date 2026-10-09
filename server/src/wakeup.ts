/*
 * One timer, set for the next thing that is due.
 *
 * A reminder tick and a schedule tick each woke every ten seconds to ask a
 * table whether anything was due: 720 statements an hour for two tables that
 * hold nothing on most machines. This asks once what the next due time is,
 * sleeps until then, and when nothing is pending has no timer at all.
 *
 * It is still ONE claimer. The callback is the same claim statement the tick
 * ran, so a cancelled row still cannot fire (cancellation is in the claim
 * predicate), boot is still just the first run, and a row cannot fire twice.
 * What changed is only when it runs. `arm()` is called by the writer that adds
 * a row, because an earlier due time than the one being waited for is the only
 * change a sleeping timer cannot see.
 *
 * The sleep is capped. `setTimeout` runs on the monotonic clock, which does not
 * count a suspended laptop, so a timer set for 09:00 and slept through would
 * wake hours late; capped at `capMs`, whatever slept through its due time fires
 * within `capMs` of waking, which is what the ten-second tick promised in ten.
 * Ceiling: resume lateness is up to `capMs` (30 s for the callers here), not
 * ten seconds.
 */
export type Wakeup = { arm(): void; now(): void; stop(): void };

const SLACK_MS = 25;     // fire just after the due time, never a hair before it
const FLOOR_MS = 250;    // a due time already past must not become a hot loop

export function createWakeup(opts: {
  /** When something is next due (epoch ms), or null for nothing pending. */
  next: () => number | null;
  /** Claim and deliver what is due. May be async; never overlapped. */
  run: () => void | Promise<void>;
  capMs: number;
}): Wakeup {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || running) return;       // a run re-arms itself when it ends
    let at: number | null;
    // A failed read must not stop the clock: look again at the cap.
    try { at = opts.next(); } catch { at = Date.now() + opts.capMs; }
    if (at === null) return;
    const delay = Math.min(opts.capMs, Math.max(FLOOR_MS, at - Date.now() + SLACK_MS));
    timer = setTimeout(fire, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const fire = () => {
    timer = null;
    if (running || stopped) return;
    running = true;
    void Promise.resolve()
      .then(opts.run)
      .catch(() => { /* the next wake tries again */ })
      .finally(() => { running = false; arm(); });
  };

  return {
    arm,
    /** Run now, then carry on from the next due time (boot is just the first run). */
    now: fire,
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
