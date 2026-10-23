// What a pointer button does in the Finder. Strata decides it per view, per kind
// of item and per button, and it is one table here so no handler decides alone.
// A browser sends `click` for the primary button only, but a handler that acts
// on mousedown or pointerdown, or one that shares a function with the context
// menu, runs for every button; each asks `activates` first.

export type PointerEvent = "click" | "mousedown" | "contextmenu" | "auxclick";

/** Only the primary button navigates or activates. The right button asks for a menu, the middle one is its own action. */
export const activates = (button: number, kind: PointerEvent): boolean => button === 0 && (kind === "click" || kind === "mousedown");

export type PointerView = "columns" | "icons" | "list" | "sidebar";
/** `empty`: the space of a folder's view where no row is. */
export type PointerItem = "folder" | "file" | "place" | "empty";
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
  /** Columns, a second click on a folder: the first already showed it, this moves to its column. */
  | "focus-child"
  /** A file under the middle button: its folder, with it selected. */
  | "reveal"
  /** Empty space: nothing selected, and in Columns no column to its right. */
  | "clear"
  /** The mouse's own back and forward buttons. */
  | "back"
  | "forward"
  | "none";

/**
 * Strata's table (read from its source, not recalled; ui/browser/columns/rows.rs,
 * ui/browser_modes.rs, ui/collection_interaction.rs, ui/browser/marquee.rs):
 * - Columns: one click on a folder shows it as the next column; the second click
 *   of a double click opens nothing else, it moves to that column. A file selects
 *   on one and opens on two.
 * - Icons and List: one click only selects, two open, folder or file.
 * - Right button: the menu, and the row is selected if it was not; nothing opens.
 * - Middle button: a folder in a new tab, a file revealed in its folder. Strata's
 *   Ctrl or Shift with it is a new window, which a finder in one window has not.
 * - Empty space: the primary button clears the selection (Columns also closes
 *   the columns to its right), the right one opens the folder's menu and leaves
 *   the selection alone. Strata's middle-button autoscroll is not here.
 * - Buttons 4 and 5 (8 and 9 to GTK): back and forward, anywhere.
 * - A sidebar place: a primary click goes there, the right button opens its menu, the middle one does nothing.
 */
export function pointerAction(view: PointerView, item: PointerItem, button: number, clicks: number): PointerAction {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  if (button === 2) return "menu";
  if (button === 1) return view === "sidebar" || item === "place" || item === "empty" || clicks !== 1 ? "none" : item === "folder" ? "new-tab" : "reveal";
  if (button !== 0) return "none";
  if (view === "sidebar" || item === "place") return "go";
  if (item === "empty") return clicks === 1 ? "clear" : "none";
  if (clicks >= 2) return view === "columns" && item === "folder" ? "focus-child" : "open";
  return view === "columns" && item === "folder" ? "pick" : "select";
}

/** Where a drag of files can be let go: a folder row, a sidebar place, a crumb of the path, a tab, a pane's empty space, the Trash. */
export type DropKind = "folder" | "place" | "crumb" | "tab" | "pane" | "trash";
/**
 * Strata's spring-loaded targets: a file drag that rests on a folder row, a
 * sidebar place or a crumb for 750 ms opens it (ui/browser/clipboard.rs), on a
 * tab for 450 ms selects it (window/composition/tabs/strip.rs), so the drop can
 * go deeper. A pane and the Trash do not open.
 */
export const springMs = (k: DropKind): number | null => (k === "tab" ? 450 : k === "folder" || k === "place" || k === "crumb" ? 750 : null);

/** GTK's drag threshold: a press that moves less than this is a click, not a rubber band. */
export const MARQUEE_SLOP = 8;
/** A press starts a rubber band on the empty space of a view, or anywhere with Alt held (Strata's force-marquee); the primary button only. */
export const startsMarquee = (button: number, onRow: boolean, alt: boolean): boolean => button === 0 && (!onRow || alt);

/**
 * Strata's slow click (ui/browser/columns/rows.rs, inline_edit.rs): a second
 * single click on the NAME of the only selected row, with no key held, renames
 * it once the double-click time has passed without a second click. Not in the
 * Trash or in Recent, where names are not the row's own.
 */
export function slowClickRenames(s: { soleSelected: boolean; onName: boolean; clicks: number; mods: boolean; place: "folder" | "trash" | "recent" }): boolean {
  return s.soleSelected && s.onName && s.clicks === 1 && !s.mods && s.place === "folder";
}
/** The double-click time the slow click waits out (GTK's default). */
export const SLOW_CLICK_MS = 400;

/** Ctrl and the wheel: the text size, a step per notch, up when the wheel goes away from the person (Strata's window/keyboard.rs). */
export const wheelTextStep = (deltaY: number): 1 | -1 | 0 => (deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0);

/** Buttons 4 and 5 are history only when the history can go that way; otherwise the press is not the finder's (Strata does not claim it). */
export const historyClaims = (a: PointerAction, can: { back: boolean; forward: boolean }): boolean => (a === "back" && can.back) || (a === "forward" && can.forward);

/**
 * Where a press on a ROW may start a file drag (Strata's rows.rs, pointer.rs,
 * browser_modes.rs): a selected row drags from anywhere on it; an unselected one
 * only from its icon or its name text. The rest of an unselected row is empty
 * space, so the press there starts a rubber band instead.
 */
export const dragStarts = (selected: boolean, onContent: boolean): boolean => selected || onContent;
/** A press starts a rubber band on the empty space of a view, on the blank part of an unselected row, or anywhere with Alt held (Strata's force-marquee); the primary button only. `row` is null off any row. */
export const startsMarqueeAt = (button: number, row: { selected: boolean; onContent: boolean } | null, alt: boolean): boolean =>
  button === 0 && (alt || row === null || !dragStarts(row.selected, row.onContent));

/** Strata's marquee autoscroll (marquee.rs): within 28 px of the list's edge, up to 24 px every 16 ms. */
export const EDGE_PX = 28;
export const EDGE_MAX = 24;
export const EDGE_TICK_MS = 16;
/** How far to scroll this tick: negative above `lo`, positive below `hi`, faster the further past the edge line, zero in the middle. */
export function edgeStep(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_PX) return -Math.min(EDGE_MAX, Math.round((EDGE_MAX * (lo + EDGE_PX - pos)) / EDGE_PX));
  if (pos > hi - EDGE_PX) return Math.min(EDGE_MAX, Math.round((EDGE_MAX * (pos - (hi - EDGE_PX))) / EDGE_PX));
  return 0;
}

/**
 * The rows a rubber band touches, worked out from the layout and not from the
 * DOM: the list draws only what is on screen, so a band that has scrolled past
 * rows would otherwise forget them. `box` is in the list's own coordinates
 * (x from its left edge, y from the top of its content). A list or a column
 * stacks rows `rowH` apart, `slotOf` giving a row's slot when group headers
 * take some; tiles sit `per` to a line, `tileW` wide from `padX`, `hitH` tall.
 */
export interface BandLayout { rowH: number; slotOf?: readonly number[]; per?: number; tileW?: number; padX?: number; hitH?: number }
export function bandRows(l: BandLayout, count: number, box: { left: number; right: number; top: number; bottom: number }): number[] {
  const out: number[] = [];
  const tiles = l.per !== undefined && l.tileW !== undefined;
  for (let i = 0; i < count; i++) {
    const slot = tiles ? Math.floor(i / l.per!) : (l.slotOf?.[i] ?? i);
    const top = slot * l.rowH;
    if (top >= box.bottom) break;
    if (top + (l.hitH ?? l.rowH) <= box.top) continue;
    if (tiles) {
      const left = (l.padX ?? 0) + (i % l.per!) * l.tileW!;
      if (left >= box.right || left + l.tileW! <= box.left) continue;
    }
    out.push(i);
  }
  return out;
}

/** A click on empty space of a column the keyboard was not in puts the cursor on its first row, unless a filter is narrowing it (Strata's columns.rs). */
export const emptyClickSelectsFirst = (returning: boolean, filtered: boolean): boolean => returning && !filtered;

/** A filter is narrowing the view: a click on a row acts at once, folders navigate and files open (Strata's rows.rs); in the Trash only folders, and never with Ctrl or Shift held. */
export const releaseActivates = (s: { filtered: boolean; isDir: boolean; trash: boolean; mods: boolean }): boolean => s.filtered && !s.mods && (s.isDir || !s.trash);
export const inTrash = (dir: string): boolean => dir.includes("/.local/share/Trash/");

/** Strata's name tooltip (icons_cell/name_tooltip.rs): the pointer rests 900 ms, within 4 px, on a caption that is cut. */
export const TIP_REST_MS = 900;
export const TIP_SLOP = 4;
export const tipMoved = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.hypot(a.x - b.x, a.y - b.y) > TIP_SLOP;

/** What a drag of files offers other programs: a uri-list of file:// links (Strata offers it too, with a file list a page cannot make). */
export const fileUris = (paths: readonly string[]): string => paths.map((p) => `file://${p.split("/").map(encodeURIComponent).join("/")}`).join("\r\n");
