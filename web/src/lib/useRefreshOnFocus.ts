import { useEffect, useRef } from "react";

/**
 * Run `fn` when the window comes back (focus, or the tab becoming visible),
 * while `active`. For state that changes outside the app and has no event to
 * listen to: it is read on open, here, and on a Refresh button, never on a clock.
 */
export function useRefreshOnFocus(active: boolean, fn: () => void): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const on = () => { if (!document.hidden) saved.current(); };
    window.addEventListener("focus", on);
    document.addEventListener("visibilitychange", on);
    return () => { window.removeEventListener("focus", on); document.removeEventListener("visibilitychange", on); };
  }, [active]);
}
