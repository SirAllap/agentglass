// Ctrl+/Ctrl− zooms whatever the pointer is over.
//
// The app had two zooms that had nothing to do with each other: the window's
// scale on Ctrl+/Ctrl−, and the terminal's font size buried in Settings →
// Terminal. So making the shell text bigger also made the terminal bigger, and
// making the terminal readable meant leaving the terminal, opening a dialog and
// finding a stepper.
//
// One gesture, two targets, chosen by where you are pointing. Over a terminal
// it is the terminal's font; anywhere else it is the window. That rule needs no
// mode, no toggle and nothing to remember — you are already pointing at the
// thing you want bigger.
//
// The pointer position is tracked rather than asked for, because a keyboard
// event carries no coordinates: `Ctrl+=` has to know where the mouse is, and
// the only way to know is to have been listening.

import { currentTermSize, setTermSize, DEFAULT_SIZE } from "./termPrefs.ts";
import { nudgeScale, resetScale, currentScale } from "./uiScale.ts";

let x = -1, y = -1;
if (typeof window !== "undefined") {
  // Passive and capture: this must never delay a scroll and must see the move
  // even when something below stops propagation.
  window.addEventListener("pointermove", (e) => { x = e.clientX; y = e.clientY; }, { passive: true, capture: true });
  // A pointer that has left the window is not over anything.
  window.addEventListener("pointerleave", () => { x = -1; y = -1; }, { passive: true, capture: true });
}

/**
 * Is the pointer over a terminal right now?
 *
 * `elementFromPoint` rather than a hover flag kept by the terminal components:
 * there are several of them (the view, the console strip, the floating file
 * viewer) plus tmux panes inside each, and a flag per surface is a flag that
 * eventually gets out of sync with the DOM. The DOM is the authority; ask it.
 */
export function overTerminal(): boolean {
  if (x < 0) return false;
  const el = document.elementFromPoint(x, y);
  return !!el?.closest(".xterm");
}

export type ZoomWhat = "terminal" | "app";
export type ZoomResult = { what: ZoomWhat; label: string };

/** How far one step moves the terminal. A point at a time: the range that is
 *  actually readable is about 9–20, so a percentage step would be either
 *  imperceptible at the bottom or a jump at the top. */
const TERM_STEP = 1;

/**
 * Zoom whatever is under the pointer. `dir` 0 resets it.
 *
 * Returns what was changed and what it now reads, so the caller can say so —
 * a zoom you cannot see the size of is a zoom you have to overshoot to find.
 */
export function zoomAtPointer(dir: 1 | -1 | 0): ZoomResult {
  if (overTerminal()) {
    const next = dir === 0 ? DEFAULT_SIZE : currentTermSize() + dir * TERM_STEP;
    setTermSize(next);
    // Read back rather than trusting the arithmetic: setTermSize clamps, and a
    // toast that says 21 while the terminal is at 20 is worse than none.
    return { what: "terminal", label: `Terminal ${currentTermSize()}px` };
  }
  const scale = dir === 0 ? resetScale() : nudgeScale(dir);
  return { what: "app", label: `App ${Math.round(scale * 100)}%` };
}

/** The app's current scale, for a caller that wants to show it without
 *  changing it. */
export const appScale = currentScale;
