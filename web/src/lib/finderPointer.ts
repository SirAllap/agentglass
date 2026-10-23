// What a pointer button does in the Finder. Strata decides it per view, per kind
// of item and per button, and it is one table here so no handler decides alone.
// A browser sends `click` for the primary button only, but a handler that acts
// on mousedown or pointerdown, or one that shares a function with the context
// menu, runs for every button; each asks `activates` first.

export type PointerEvent = "click" | "mousedown" | "contextmenu" | "auxclick";

/** Only the primary button navigates or activates. The right button asks for a menu, the middle one is its own action. */
export const activates = (button: number, kind: PointerEvent): boolean => button === 0 && (kind === "click" || kind === "mousedown");

export type PointerView = "columns" | "icons" | "list" | "sidebar";
export type PointerItem = "folder" | "file" | "place";
export type PointerAction =
  /** Make the row the selection, and leave the folder shown as it is. */
  | "select"
  /** Select the row and, for a folder, show it as the next column (Columns only). */
  | "pick"
  /** Open the item: a folder is entered, a file goes to the editor. */
  | "open"
  /** Open the item's context menu, selecting the row first if it is not selected. */
  | "menu"
  /** A folder in a new tab. */
  | "new-tab"
  /** A sidebar place: go there. */
  | "go"
  | "none";

/**
 * Strata's table (read from its source, not recalled):
 * - Columns: one click on a folder shows it as the next column, two enter it; a file selects on one, opens on two.
 * - Icons and List: one click only selects, two open, folder or file.
 * - Right button: the menu, and the row is selected if it was not; nothing opens.
 * - Middle button on a folder row: a new tab. On a file Strata reveals its parent, which is the folder already shown.
 * - A sidebar place: a primary click goes there, the right button opens its menu, the middle one does nothing.
 */
export function pointerAction(view: PointerView, item: PointerItem, button: number, clicks: number): PointerAction {
  if (button === 2) return "menu";
  if (button === 1) return view !== "sidebar" && item === "folder" ? "new-tab" : "none";
  if (button !== 0) return "none";
  if (view === "sidebar" || item === "place") return "go";
  if (clicks >= 2) return "open";
  return view === "columns" && item === "folder" ? "pick" : "select";
}
