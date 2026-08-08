/**
 * A read that is allowed to be too early.
 *
 * The window opens before the sidecar is listening — index.html's own splash
 * says "waiting for the server…" for exactly that reason — so the first fetch a
 * panel makes on mount can simply fail. A `.catch(() => {})` around it turns
 * that into a permanent blank: nothing threw, nothing retried, and the screen
 * kept whatever it had. That is how the command bar came to show
 * `recipe:rmsh8muud0` on a chip until somebody opened the menu, which re-ran
 * the fetch by accident.
 *
 * Bounded on purpose. This is for the seconds around startup, not a general
 * "keep trying forever": four goes over about eight seconds, then it stops and
 * leaves the screen as it was. A read that is failing for any other reason —
 * no repo, no permission — must not become a poll.
 */

/** Rising gaps, in ms. Short enough that a fast start is unnoticeable, long
 *  enough to cover a slow one. */
const DEFAULT_DELAYS = [300, 800, 2_000, 5_000];

export interface RetryLoadOpts {
  delays?: number[];
  /** Injected so a test does not have to wait in real time. */
  wait?: (ms: number, fn: () => void) => unknown;
  clear?: (handle: unknown) => void;
}

/**
 * Run `load` until it reports success, backing off between goes.
 *
 * `load` returns whether it worked; anything falsy, and anything thrown, counts
 * as a failure. The returned function cancels: call it from an effect's
 * cleanup, and no further attempt runs.
 */
export function retryLoad(load: () => Promise<boolean>, opts: RetryLoadOpts = {}): () => void {
  const delays = opts.delays ?? DEFAULT_DELAYS;
  const wait = opts.wait ?? ((ms, fn) => setTimeout(fn, ms));
  const clear = opts.clear ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let cancelled = false;
  let handle: unknown;
  let attempts = 0;

  const attempt = (): void => {
    void Promise.resolve()
      .then(load)
      .then((ok) => ok === true)
      .catch(() => false)
      .then((ok) => {
        if (ok || cancelled || attempts >= delays.length) return;
        handle = wait(delays[attempts++]!, attempt);
      });
  };
  attempt();

  return () => {
    cancelled = true;
    if (handle !== undefined) clear(handle);
  };
}
