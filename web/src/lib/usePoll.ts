// Keep an open panel current.
//
// The git and diff panels loaded once, when they opened, and then went stale:
// commit from a terminal, switch branch, let the fleet edit a file, and the
// panel kept showing the world as it was minutes ago — with no sign it was out
// of date. The only fix was to close and reopen it, which is a workaround the
// user has to invent and then remember.
//
// The live event feed doesn't have this problem because it's pushed over the
// WebSocket. Git state isn't pushed: it changes from outside the app entirely
// (a terminal, an editor, another agent), so nothing emits an event for it.
// Polling is the honest answer for state we can't be notified about.
import { useEffect, useRef } from "react";

/**
 * Run `fn` on an interval while `active`, and immediately whenever the window
 * regains focus.
 *
 * Gated on `document.hidden` only. Losing focus pauses nothing: a window open
 * on a second screen while the person types elsewhere is still looked at, and
 * freezing it there made live panels go stale. Becoming visible again
 * refreshes at once, so the pause while hidden is invisible.
 */
export function usePoll(active: boolean, fn: () => void, ms = 2500) {
  // Held in a ref so a caller can pass an inline closure without the interval
  // being torn down and rebuilt on every render.
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!active) return;
    return pollWhileLooking(() => saved.current(), ms);
  }, [active, ms]);
}

/**
 * The same gate for a module that is not a component (a store that polls for
 * the life of the page): `fn` every `ms` while the window is looked at, and
 * once at each return to it. Returns the function that stops it.
 */
export function pollWhileLooking(fn: () => void, ms: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const looking = () => isLooking(document.hidden);
  const tick = () => { if (looking()) fn(); };
  const start = () => setInterval(tick, ms);
  // The timer exists only while the window is looked at: with ~40 pollers a
  // parked window otherwise wakes the renderer 40 times a period to do nothing.
  const sync = () => {
    const was = id !== null, now = looking();
    if (now && !was) id = start();
    else if (!now && was) { clearInterval(id!); id = null; }
    if (shouldPollNow(was, now)) fn();
  };
  if (looking()) id = start();
  document.addEventListener("visibilitychange", sync);
  return () => {
    if (id !== null) clearInterval(id);
    id = null;
    document.removeEventListener("visibilitychange", sync);
  };
}

/** Is the window looked at? Pure: visible means yes. Focus is not part of it: a window
 *  left open on a second screen while the person types elsewhere is still looked at. */
export function isLooking(hidden: boolean): boolean {
  return !hidden;
}

/** Does `fn` run at once? Only on the edge from not looking to looking. */
export function shouldPollNow(wasLooking: boolean, looking: boolean): boolean {
  return looking && !wasLooking;
}

/** Value of `data-idle` on the root: "1" freezes every endless CSS loop. The inverse of isLooking. */
export function idleFlag(hidden: boolean): "0" | "1" {
  return isLooking(hidden) ? "0" : "1";
}
