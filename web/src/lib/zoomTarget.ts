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
import { currentPageZoomer } from "./browserDrive.ts";

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

/**
 * Is the pointer over a web page the browser is showing?
 *
 * By RECTANGLE, not by `elementFromPoint`, which is how `overTerminal` asks and
 * what the first draft of this did. Measured on the running app: the point at
 * the centre of the `<webview>` comes back as a `DIV`, because the panel lays
 * its own surfaces over the guest — the drag target, the find bar, the shade
 * while a page loads. `closest("webview")` was therefore false everywhere on
 * the page, and the whole branch below never ran once.
 *
 * A terminal can be asked the other way because its DOM is this document's.
 * A guest's is not: `<webview>` is a hole in the page with another process
 * behind it, so the only thing this document can honestly say about it is
 * where it is.
 *
 * Only a webview that is actually laid out: one in a hidden panel has an empty
 * rect, and a point is never inside an empty rect.
 */
export function overBrowserPage(): boolean {
  if (x < 0) return false;
  for (const el of document.querySelectorAll("webview")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

export type ZoomWhat = "terminal" | "app" | "page";
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
export async function zoomAtPointer(dir: 1 | -1 | 0): Promise<ZoomResult> {
  if (overTerminal()) {
    const next = dir === 0 ? DEFAULT_SIZE : currentTermSize() + dir * TERM_STEP;
    setTermSize(next);
    // Read back rather than trusting the arithmetic: setTermSize clamps, and a
    // toast that says 21 while the terminal is at 20 is worse than none.
    return { what: "terminal", label: `Terminal ${currentTermSize()}px` };
  }
  /*
   * A web page is a third thing to be pointing at, and it was missing.
   *
   * The rule this file exists for — zoom whatever is under the pointer — had
   * two answers, and a page in the browser panel fell into "anywhere else", so
   * Ctrl+ over a web page scaled the entire window. Measured on the running
   * app with the pointer over the page: the window's dpr went 1.25 -> 1.5625
   * and the page came back at innerWidth 2790, exactly what it started at.
   * That is what "the zoom I see is the whole app's, not the page's"
   * describes, and no amount of work in the panel could fix it, because the
   * panel was never asked.
   *
   * The panel registers the zoomer while it is mounted; this asks whoever is
   * registered. `zoomTarget` never resolves a guest itself — only the panel
   * knows which tab is on screen, and a second resolver is the exact shape of
   * the bug that had captures photographing the wrong tab.
   *
   * If nothing is registered, or the page refuses, this falls through to the
   * window rather than eating the gesture: a zoom that does nothing at all is
   * worse than one that zooms the wrong thing, because there is no way to tell
   * it from a dead key.
   */
  if (overBrowserPage()) {
    const zoomer = currentPageZoomer();
    if (zoomer) {
      try {
        const r = await zoomer(dir);
        if (r) return { what: "page", label: `Page ${r.percent}%` };
      } catch { /* fall through to the window */ }
    }
  }
  const scale = dir === 0 ? resetScale() : nudgeScale(dir);
  return { what: "app", label: `App ${Math.round(scale * 100)}%` };
}

/** The app's current scale, for a caller that wants to show it without
 *  changing it. */
export const appScale = currentScale;
