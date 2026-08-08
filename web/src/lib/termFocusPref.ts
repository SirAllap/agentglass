/*
 * Focus follows mouse, for terminal panes.
 *
 * The window manager idea, scoped to the one place in this app where it earns
 * its keep. Everything else here is clicked; a terminal is TYPED INTO, and the
 * gap between "the pane I am looking at" and "the pane the keyboard is going
 * to" is a keystroke that lands somewhere else. Click the rail, open a picker,
 * dismiss a dialog, and the cursor is on a button — so getting back to work
 * costs a click that exists only to say "yes, that one".
 *
 * Off by default, and it has to be. Focus that moves without being asked is
 * exactly the behaviour people either love or find unusable, and a machine that
 * has never been told is a machine whose owner expects the click.
 */

const KEY = "agentglass.term.focusFollowsMouse";

export function focusFollowsMouse(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

const listeners = new Set<() => void>();

export function setFocusFollowsMouse(on: boolean): void {
  // Written as an absent key when off, so the default can change later without
  // every machine that merely looked at the switch being pinned to the old one.
  try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribeFocusFollowsMouse(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Should this hover take the keyboard?
 *
 * Pulled out of the component because the answer is four guards and no DOM, and
 * every one of them is a way the feature turns from helpful into hostile:
 *
 *   `enabled`   nobody asked for this.
 *   `buttons`   a button is down, so this is a selection being dragged across a
 *               split, not a hover. Taking focus mid-drag re-mounts the pane
 *               and loses what was being selected.
 *   `typing`    a menu or the find bar has borrowed the keyboard for an input
 *               of its own. Passing over a pane on the way back to it must not
 *               swallow the next character of what is being typed.
 *   `visible`   the view is not on screen. Hidden panes cannot be hovered, but
 *               a stray synthetic event must not focus one either.
 */
export function shouldFocusOnHover(o: {
  enabled: boolean;
  /** `MouseEvent.buttons` — a bitmask, 0 when nothing is held. */
  buttons: number;
  /** Something in the panel's own chrome has the keyboard. */
  typing: boolean;
  visible: boolean;
}): boolean {
  return o.enabled && o.visible && !o.typing && o.buttons === 0;
}
