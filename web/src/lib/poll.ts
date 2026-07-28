/**
 * Polling that stops costing anything while nobody is looking.
 *
 * The phone runs five of these — gates and sessions every 4s, docker every 15s,
 * working trees every 30s, pull requests every 60s, and a transcript every 5s
 * while a chat is open — and every one of them ran flat out with the tab
 * hidden. On a desk that is a few wasted requests; on a phone it is a radio
 * wake per tick, which is the part that shows up in a battery graph.
 *
 * Skipping the work rather than clearing the timer is deliberate: browsers
 * already throttle background timers to near-nothing, so the timer itself is
 * free, and keeping it means coming back needs no re-arming.
 *
 * The catch-up is the half that makes it safe to skip at all. Returning to a
 * view showing data from before you left is worse than the requests saved, so
 * a poll that missed a tick runs immediately when the page becomes visible —
 * and one that missed nothing does not, so tabbing away and straight back does
 * not fire a burst.
 */

/** The document surface this needs, so the rule can be tested without a DOM. */
export interface PollDoc {
  hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/**
 * Run `fn` every `ms`, but only while the page is visible — and once on the
 * way back if a tick was missed. Returns the stop function to hand to a React
 * effect's cleanup.
 */
export function pollWhileVisible(fn: () => void, ms: number, doc?: PollDoc): () => void {
  const d = doc ?? (typeof document === "undefined" ? null : (document as unknown as PollDoc));
  // No document at all (a test, SSR): behave like a plain interval rather than
  // silently never running.
  if (!d) {
    const plain = setInterval(fn, ms);
    return () => clearInterval(plain);
  }

  let missed = false;
  const timer = setInterval(() => {
    if (d.hidden) { missed = true; return; }
    fn();
  }, ms);

  const wake = () => {
    if (d.hidden || !missed) return;
    missed = false;
    fn();
  };
  d.addEventListener("visibilitychange", wake);

  return () => {
    clearInterval(timer);
    d.removeEventListener("visibilitychange", wake);
  };
}
