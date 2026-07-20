// UI scale — the desktop window's answer to "everything is tiny on a 4K screen".
//
// Deliberately NOT a font-size setting. Every size in this UI is an absolute px
// literal (400-odd `text-[11px]`-style classes, zero rem), so growing type alone
// would push text out of panels that stayed the same size — the dashboard would
// break exactly where it's densest, in the KPI tiles and the feed. What actually
// helps is scaling the whole window, which is what VS Code's `window.zoomLevel`,
// Slack's View → Zoom and Chrome's own zoom all do: the webview relays out at a
// smaller CSS viewport, so type, padding, icons and charts grow together and the
// responsive breakpoints still get to do their job.
//
// A fixed ladder rather than a free slider, and a hard ceiling. The cockpit's
// 12-column grid folds into a stacked layout below 1280 CSS px, so unbounded
// zoom would quietly turn a 4K dashboard into a phone one — 150% keeps a
// maximised window on the wide layout, which is the whole point of the screen.

import { setWindowZoom } from "./desktop.ts";

const KEY = "agentglass.uiScale";

/** The rungs, smallest first. 150% is the ceiling — see the note above. */
export const SCALES: number[] = [0.9, 1, 1.1, 1.25, 1.4, 1.5];
export const DEFAULT_SCALE = 1;

let current = DEFAULT_SCALE;

/** Snap to the nearest rung, so a hand-edited localStorage value can't smuggle
 *  in a 4× that leaves the window unusable and unrecoverable. */
function snap(v: number): number {
  return SCALES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), SCALES[0]);
}

export function currentScale(): number {
  return current;
}

export function canZoomIn(): boolean {
  return current < SCALES[SCALES.length - 1];
}

export function canZoomOut(): boolean {
  return current > SCALES[0];
}

/** Apply and remember a scale; returns the one actually in effect. */
export function setScale(v: number): number {
  current = snap(v);
  try { localStorage.setItem(KEY, String(current)); } catch { /* private mode */ }
  void setWindowZoom(current);
  return current;
}

/** Step one rung up (+1) or down (-1), stopping at the ends. */
export function nudgeScale(dir: 1 | -1): number {
  const i = SCALES.indexOf(current);
  const next = Math.min(SCALES.length - 1, Math.max(0, (i < 0 ? SCALES.indexOf(DEFAULT_SCALE) : i) + dir));
  return setScale(SCALES[next]);
}

export function resetScale(): number {
  return setScale(DEFAULT_SCALE);
}

/** The scale to boot at. The webview always starts at 100%, so this has to be
 *  re-applied on every launch rather than being remembered by the shell. */
export function restoreScale(): number {
  let saved = DEFAULT_SCALE;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = parseFloat(raw) || DEFAULT_SCALE;
  } catch { /* private mode */ }
  return setScale(saved);
}

/** "125%" — how the current scale reads in the settings row. */
export function fmtScale(v: number): string {
  return Math.round(v * 100) + "%";
}
