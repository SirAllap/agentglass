// Dragging a page onto the shelf, without the HTML5 drag API.
//
// The first version used `draggable` + `dragstart`/`dragover`/`drop`. It
// rendered the attribute, the handlers were wired, and nothing happened when he
// tried it — twice. Rather than keep guessing at why (a frameless Electron
// window, a `<webview>` sibling, a scroller, an `onMouseDown` that selects the
// row: any of them is a plausible suspect and none of them is provable from
// here), the drag is done with pointer events, which this app already uses for
// every other handle it has and which cannot be cancelled by a stack it cannot
// see.
//
// What lives here is the part worth testing without a DOM: where a pointer is
// says where the page would land. The panel does the pointer capture and draws
// the ghost; this decides what a drop means.

import type { ShelfSpot } from "./browserShelf.ts";

/**
 * Where a drag can land.
 *
 * The shelf's three places, plus the list of open tabs — because dragging works
 * both ways: a tab dropped on the shelf is kept, and a kept page dropped back
 * among the tabs stops being kept. A one-way drag would be a trap you can only
 * get out of through a menu.
 */
export type DragSpot = ShelfSpot | { to: "tabs" };

/** How far the pointer must travel before it is a drag and not a click. Four
 *  pixels: a click on a tab row must still select it, and a hand resting on a
 *  trackpad moves one or two. */
export const DRAG_SLOP = 4;

export interface DropAt {
  spot: DragSpot;
  /** Where in the list, when the drop was on a row rather than on a container.
   *  Absent means the end. */
  index?: number;
}

/**
 * What the element under the pointer says a drop there would mean.
 *
 * Read off data attributes rather than from a map of element ids: the shelf is
 * a tree that redraws on every change, and anything that remembers WHICH
 * element was where goes stale the moment a folder is folded.
 */
export function parseDrop(attr: (name: string) => string | null | undefined): DropAt | null {
  const to = attr("data-drop-to");
  if (!to) return null;
  const rawIndex = attr("data-drop-index");
  const index = rawIndex == null || rawIndex === "" ? undefined : Number(rawIndex);
  const at = index != null && Number.isFinite(index) && index >= 0 ? { index } : {};
  if (to === "essentials") return { spot: { to: "essentials" }, ...at };
  if (to === "loose") return { spot: { to: "loose" }, ...at };
  if (to === "tabs") return { spot: { to: "tabs" }, ...at };
  if (to === "folder") {
    const id = attr("data-drop-id");
    // A folder drop with no folder is a bug upstream, and treating it as "the
    // loose pins" would move somebody's page somewhere they did not aim at.
    return id ? { spot: { to: "folder", id }, ...at } : null;
  }
  return null;
}

/** Has the pointer moved far enough to mean it? */
export const isDrag = (from: { x: number; y: number }, to: { x: number; y: number }): boolean =>
  Math.abs(to.x - from.x) >= DRAG_SLOP || Math.abs(to.y - from.y) >= DRAG_SLOP;

/**
 * Above the middle of a row, or below it.
 *
 * Which half decides whether the page lands before or after that row, and it is
 * the difference between a list that reorders the way people expect and one
 * that always appends. `rect` is the row; `y` is the pointer.
 */
export const dropsBefore = (rect: { top: number; height: number }, y: number): boolean =>
  y < rect.top + rect.height / 2;
