/*
 * How wide the person dragged the docked detail. One number, the person's own: the
 * panel clamps it to the room it has (lib/prDock.ts dockWidth) and never rewrites it,
 * so a stored 900 comes back on the big screen after a day on the small one.
 *
 * Same convention as the board's folded lanes (lib/boardPrefs.ts): key
 * `agentglass.pr.<thing>`, and the default is not written down: a default worth
 * storing is one that will disagree with the code the day it changes.
 */
import { DOCK_PX } from "./prDock.ts";

const KEY = "agentglass.pr.dockWidth";

/** The stored width, or the default when there is none or it is not a usable number. */
export function dockPref(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : DOCK_PX;
  } catch { return DOCK_PX; }
}

export function setDockPref(px: number): void {
  try {
    if (!Number.isFinite(px) || Math.round(px) === DOCK_PX) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(px)));
  } catch { /* private mode, or a browser that has said no */ }
}
