/*
 * The bar a pane draws under its own bottom edge: whether it is there at all.
 *
 * One question now, where there used to be two. The block this replaced had a
 * grip, because it sat in the corner where the newest output lands and had to
 * be pushed out of the way mid-work; the bar is under the pane's edge already,
 * and the seam that opens it is 4px of decoration. There is nothing to fold.
 *
 * The key is unchanged so nobody's "off" is forgotten by the rewrite.
 */

const MODE_KEY = "agentglass.term.paneActions";

/** `hover` draws the seam on the pane under the pointer, and the bar when the
 *  pointer is on the seam; `off` is off. ("always" is what the block used to
 *  offer — a faint copy on every pane — and a machine that chose it reads as
 *  `hover`, which is what a seam already is.) */
export type PaneActionsMode = "hover" | "off";

export function paneActionsMode(): PaneActionsMode {
  try {
    return localStorage.getItem(MODE_KEY) === "off" ? "off" : "hover";
  } catch { return "hover"; }
}

const listeners = new Set<() => void>();

export function setPaneActionsMode(mode: PaneActionsMode): void {
  // The default is written as an ABSENT key, so it can change later without
  // pinning every machine that merely opened the settings panel to the old one.
  try { if (mode === "hover") localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export function subscribePaneActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
