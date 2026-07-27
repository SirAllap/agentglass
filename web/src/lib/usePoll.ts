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
 * Paused while the document is hidden: each tick shells out to `git`, and a
 * panel left open on a background desktop should not keep spawning processes
 * for output nobody is looking at. Coming back to the window refreshes at once,
 * so the pause is invisible — that is also the moment the state is most likely
 * to have changed underneath you.
 */
export function usePoll(active: boolean, fn: () => void | Promise<unknown>, ms = 2500, immediate = false, key = "") {
  // Held in a ref so a caller can pass an inline closure without the interval
  // being torn down and rebuilt on every render.
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    const tick = () => {
      if (document.hidden || inFlight) return;
      try {
        const result = saved.current();
        if (result && typeof result.then === "function") {
          inFlight = true;
          void result.catch(() => {}).finally(() => { inFlight = false; });
        }
      } catch { /* the next interval or focus refresh may recover */ }
    };
    if (immediate) tick();
    const id = setInterval(tick, ms);
    const onVisible = () => { if (!document.hidden) tick(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, ms, immediate, key]);
}
