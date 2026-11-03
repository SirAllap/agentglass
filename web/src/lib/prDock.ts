/**
 * Where the open pull request goes: beside the board, over it, or nowhere.
 *
 * One click on a card docks the detail next to the board; a double-click, or
 * the header button, takes the whole panel; the same button gives it back. The
 * choices live here, away from the screen, because a screen cannot be asked
 * "what does Esc do now?" without drawing it.
 *
 * Whether it is maximized is not remembered between visits: a panel that
 * opens maximized because of last week is a panel nobody can explain. How wide
 * the dock is, is: that is a width the person chose with their hand (see
 * lib/prDockPref.ts).
 */

import { LANE_WIDTH_PX, RAIL_WIDTH_PX } from "./prSearch.ts";

export type Dock = {
  /** The pull request open, or null when only the list is. */
  selected: number | null;
  /** The detail has the whole panel. Meaningless while nothing is open. */
  maximized: boolean;
};

export const NOTHING_OPEN: Dock = { selected: null, maximized: false };

/** Docked detail width. The mockup's CSS says 580 and then overrides it with 620. */
export const DOCK_PX = 620;
/** The panel width at or under which there is no room for a board beside the detail: full screen only. */
export const FULL_ONLY_PX = 560;
/** What the board keeps beside a docked detail before the detail gives way. */
export const BOARD_MIN_PX = 240;

/** The narrowest dock: the width the panel keeps when it is only just wider than full-screen-only. Header row, tab strip and dock were measured to fit whole here (lib/prTabFit.ts). */
export const DOCK_MIN_PX = FULL_ONLY_PX - BOARD_MIN_PX;
/** The board scroller's own padding (TriageBoard's `p-3`), both sides. */
export const BOARD_PAD_PX = 24;
/**
 * What the board keeps beside a dock: the widest single lane (the 336px card, 8px of air each side, and the gutter rail a stacked lane
 * hangs) plus the scroller's padding. Under this the lane scrolls sideways under a lone column. The ceiling: a lane without a rail has
 * 26px to spare, because the dock does not know which lanes carry one.
 */
export const LANE_PX = LANE_WIDTH_PX + RAIL_WIDTH_PX + BOARD_PAD_PX;
/** Arrow-key step on the dock's grip, and the Shift step. */
export const DOCK_STEP_PX = 16;
export const DOCK_BIG_STEP_PX = 64;

/** The widest dock for a panel this wide: all but one lane, and never under the narrowest. */
export function dockMax(panelPx: number): number {
  return Math.max(DOCK_MIN_PX, Math.floor(panelPx - LANE_PX));
}

/** Any width pulled into the dock's range for this panel. Not a number: the default. */
export function clampDock(px: number, panelPx: number): number {
  if (!Number.isFinite(px)) px = DOCK_PX;
  return Math.min(dockMax(panelPx), Math.max(DOCK_MIN_PX, Math.round(px)));
}

/**
 * Docked width for a panel this wide, or null when the detail may only take the
 * whole panel. `chosen` is the width the person dragged it to (default 620);
 * a smaller panel clamps it here rather than rewriting it, so the choice comes
 * back with the room.
 */
export function dockWidth(panelPx: number, chosen: number = DOCK_PX): number | null {
  if (!(panelPx > FULL_ONLY_PX)) return null;
  return clampDock(chosen, panelPx);
}

/**
 * Where a key on the focused grip takes the dock, or null for a key that is not
 * the grip's. The grip is on the dock's LEFT edge, so ArrowLeft moves the edge
 * left and the dock grows.
 */
export function dockKeyWidth(key: string, shift: boolean, cur: number, panelPx: number): number | null {
  const step = shift ? DOCK_BIG_STEP_PX : DOCK_STEP_PX;
  if (key === "ArrowLeft") return clampDock(cur + step, panelPx);
  if (key === "ArrowRight") return clampDock(cur - step, panelPx);
  if (key === "Home") return DOCK_MIN_PX;
  if (key === "End") return dockMax(panelPx);
  return null;
}

/** How a pull request was asked for. Only a double-click, or the button, asks for the whole panel. */
export type OpenHow = "click" | "dblclick";

/**
 * Open `n`. A click docks it, unless the panel cannot hold a dock or the detail
 * already has the whole panel (a pin or a link opened from full screen stays
 * full screen: the mode you chose is not undone by where the next one came from).
 */
export function openPr(cur: Dock, n: number, how: OpenHow = "click", panelPx = Infinity): Dock {
  const fullOnly = dockWidth(panelPx) === null;
  return { selected: n, maximized: how === "dblclick" || fullOnly || (cur.selected != null && cur.maximized) };
}

/** The header button: the whole panel, or back to the dock. Nothing open, nothing to do. */
export function toggleMaximized(cur: Dock, panelPx = Infinity): Dock {
  if (cur.selected == null) return cur;
  if (cur.maximized && dockWidth(panelPx) === null) return cur; // no room to restore into
  return { ...cur, maximized: !cur.maximized };
}

/** Which parts of the panel are drawn. */
export type Parts = {
  /** The list column: the board, results, Inbox or CI. */
  list: boolean;
  /** The one top bar of the list view, with its views, deck and search; otherwise the detail's own bar with the way back. */
  listBar: boolean;
  /** "docked" sits beside the list, "full" replaces it. */
  detail: "none" | "docked" | "full";
};

export function parts(cur: Dock): Parts {
  if (cur.selected == null) return { list: true, listBar: true, detail: "none" };
  if (cur.maximized) return { list: false, listBar: false, detail: "full" };
  return { list: true, listBar: true, detail: "docked" };
}

/** What the open layers say, read by Esc. */
export type EscContext = {
  dock: Dock;
  /** A menu, popover or dialog is open: it closes first, and owns the key. */
  overlay: boolean;
  /** The caret is in a field: the field blurs (or clears) on its own Esc. */
  typing: boolean;
  /** The search box has text in it. */
  searchText: boolean;
};

export type EscStep = "none" | "clear-search" | "restore" | "close";

/**
 * Esc, one rung per press: an open popover or dialog, then the search text,
 * then full screen back to the dock, then the dock itself. The first rung is
 * not ours (it closes itself), so it answers "none" and the rest wait.
 */
export function escStep(c: EscContext): EscStep {
  if (c.overlay || c.typing) return "none";
  if (c.searchText) return "clear-search";
  if (c.dock.selected == null) return "none";
  return c.dock.maximized ? "restore" : "close";
}

/** Apply a rung that changes the layout. "clear-search" is the caller's. */
export function afterEsc(cur: Dock, step: EscStep): Dock {
  if (step === "restore") return { ...cur, maximized: false };
  if (step === "close") return NOTHING_OPEN;
  return cur;
}

/** Detail width at or under which the sidebar folds into a "Details" fold above the reading (the mockup's 860px container query). */
export const SIDE_FOLDS_PX = 860;
/** Detail width at or under which the detail is compact: the Files tree narrows (the mockup's 760px container query). */
export const COMPACT_PX = 760;

export type DetailBand = "wide" | "mid" | "narrow";

/**
 * Which of the mockup's two container queries apply to a detail this wide.
 *
 * Measured with a ResizeObserver and answered here rather than by
 * `container-type` on the detail: layout containment makes the detail the
 * containing block of every fixed popover inside it, and they would all
 * re-anchor to it. An unmeasured width (null, NaN, 0) is the wide layout,
 * which is also what a first paint draws.
 */
export function detailBand(px: number | null): DetailBand {
  if (px == null || !(px > 0)) return "wide";
  if (px <= COMPACT_PX) return "narrow";
  return px <= SIDE_FOLDS_PX ? "mid" : "wide";
}

export interface MastheadPlan {
  /** "#N title" shares the action row and stops at one line (its whole text is its tooltip). Where it cannot fit beside the actions it wraps to a row of its own. */
  titleOneLine: boolean;
  /** The row of who and where never wraps: the branch name gives way first. */
  metaOneRow: boolean;
  /** Draw the cells that only say a nothing: "not checked out here" and the dimmed "Not stacked" twin. The narrow band gives them up before it wraps. */
  showQuiet: boolean;
}

/**
 * What the detail's header draws at this band. At the default 620px dock (the narrow band) the header was four lines: the title had a row to
 * itself and the row of who and where wrapped. It is two now: the title beside the actions, and one meta row. The ceiling: a dock narrower
 * than about 500px cannot hold the title beside the actions, so there it wraps to its own row (three lines), by the row's own flex-wrap. The meta row wraps too, once its pieces (the branch keeps 9rem before they do) do not fit one line: at the 320px dock it was a nowrap row whose chips collapsed onto each other.
 */
export function mastheadPlan(band: DetailBand): MastheadPlan {
  return band === "narrow"
    ? { titleOneLine: true, metaOneRow: true, showQuiet: false }
    : { titleOneLine: false, metaOneRow: false, showQuiet: true };
}
