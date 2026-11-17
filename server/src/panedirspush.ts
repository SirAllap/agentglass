/*
 * "A pane's directory may have moved" — one small push instead of a poll.
 *
 * The window asked `/terminal/pane-dirs` every 4 s for every pane (about 15
 * requests a minute, each a `list-panes`). tmux already says when a window
 * opens, closes, splits or its active pane's path changes: the control-mode
 * sidecar (tmuxwatch.ts) subscribes to those fields. Each such notification
 * lands here, is folded into one frame inside DEBOUNCE_MS, and the client
 * re-reads only then. The client keeps a slow poll as the backstop for a
 * change tmux does not announce (a cd in a pane that is not the active one).
 */
import { setTimeoutAs } from "./loopwatch.ts";

export const PANEDIRS_DEBOUNCE_MS = 250;

let listener: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Who hears the push: index.ts broadcasts it to the app's clients. One listener; null in a test. */
export function onPaneDirsChanged(fn: (() => void) | null): void {
  listener = fn;
  if (!fn && timer) { clearTimeout(timer); timer = null; }
}

/** tmux said a window or a pane path changed. A burst is one frame. */
export function pokePaneDirs(delayMs: number = PANEDIRS_DEBOUNCE_MS): void {
  if (timer) return;
  timer = setTimeoutAs("pane-dirs push", () => {
    timer = null;
    try { listener?.(); } catch { /* a push is best effort */ }
  }, delayMs);
}

export const PANEDIRS_FALLBACK_MS = 4000;
let lastFallback = 0;

/** The sidecar is not alive, so tmux says nothing: the server poll stands in, at most once per PANEDIRS_FALLBACK_MS (the old client beat). */
export function pokePaneDirsFallback(now: number = Date.now()): boolean {
  if (now - lastFallback < PANEDIRS_FALLBACK_MS) return false;
  lastFallback = now;
  pokePaneDirs();
  return true;
}
