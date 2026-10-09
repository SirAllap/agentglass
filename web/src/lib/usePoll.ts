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
 * Gated on focus, not just `document.hidden`: a desktop window has no tab to
 * background, so `hidden` stays false for its entire life, and a panel left
 * open on a second monitor all day — visible, untouched — polled at full rate
 * forever for nobody. `document.hasFocus()` is the signal that also catches
 * that case, the same test TasksPanel's own poll already uses for the same
 * reason. Coming back to the window refreshes at once, so the pause is
 * invisible — that is also the moment the state is most likely to have
 * changed underneath you.
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
  const looking = () => !document.hidden && document.hasFocus();
  const tick = () => { if (looking()) fn(); };
  const id = setInterval(tick, ms);
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(id);
    window.removeEventListener("focus", tick);
    document.removeEventListener("visibilitychange", tick);
  };
}
