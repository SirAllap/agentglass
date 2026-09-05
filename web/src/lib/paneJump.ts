/**
 * "Take me to that pane" — the one act the Crew board allows itself.
 *
 * A registry rather than an import of the resolver, for the reason sysNotify
 * keeps its own `goto` behind `setAlertGoto`: the resolver lives in App (it
 * needs the view switch and the terminal API), and the surfaces that want it
 * live below App. This module has no side effects at import time — sysNotify
 * reads localStorage the moment it loads, and a row component that imported
 * it could no longer be rendered in a test.
 *
 * App registers the same resolver a notification about the pane uses, so a
 * Crew row and the bell's row for the same agent land in the same place.
 */
let jump: ((paneId: string) => void) | null = null;

export function setPaneJump(fn: typeof jump): void { jump = fn; }

/** Go to the pane. False when nothing has registered — a test, or a surface
 *  mounted without the app around it. */
export function jumpToPane(paneId: string): boolean {
  if (!jump) return false;
  jump(paneId);
  return true;
}
