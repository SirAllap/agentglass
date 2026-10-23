/*
 * The window each computer was last on, so switching away and back lands where
 * you were instead of on whichever window the "best session" rule picks.
 *
 * In memory only: a pane id belongs to a tmux server and does not outlive it,
 * and one that does not exist any more falls through to the rule above.
 * Keyed by computer because `%5` is a different window on each.
 */
const panes = new Map<string, string>();

export function rememberPane(computerId: string | undefined, pane: string | null): void {
  // A null is the frame while a strip loads, not "no window"; keeping the old
  // value is what lets the return trip find it.
  if (computerId && pane) panes.set(computerId, pane);
}

export function lastPane(computerId: string | undefined): string | null {
  return (computerId && panes.get(computerId)) || null;
}

export function __resetPanes(): void { panes.clear(); }
