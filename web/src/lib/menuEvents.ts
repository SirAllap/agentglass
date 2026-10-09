/*
 * What a menu keeps to itself.
 *
 * A portal moves the menu's DOM to <body>, but React still delivers its events
 * up the React tree: a click on "Copy card URL" bubbled out of the menu, into
 * the row that had opened it, and ran the row's own onClick — so copying an id
 * also opened the card. Measured in headless Chrome with real input: item click
 * gave [copy-url, row-click]; Enter on a focused item gave [row-enter,
 * copy-url, row-click]; a click on the dismissing catcher reached the row as a
 * mousedown. The same menu is used by the rail, the Git rows, the PR chips and
 * the board rows, and any of them that opens from inside a clickable parent had
 * the bug, so the containment lives on the menu and not on each parent.
 *
 * Only what a parent could mistake for its own gesture is held back. Keys are
 * limited to the two that activate a button: stopping every keydown would also
 * hide the app's chords from the window while a menu is open, and that was
 * working. The ceiling: a parent listening in the capture phase still sees it.
 */
type Stoppable = { stopPropagation: () => void };
type KeyLike = Stoppable & { key: string };

/** The pointer and touch events a menu swallows. */
export const MENU_POINTER_EVENTS = [
  "onClick", "onDoubleClick", "onMouseDown", "onMouseUp", "onPointerDown", "onPointerUp",
  "onTouchStart", "onTouchEnd", "onContextMenu",
] as const;

/** Keys that press a focused button, and so reach a parent as a "click" or a row's own Enter. */
export const MENU_ACTIVATION_KEYS = ["Enter", " "] as const;

export function swallowsKey(key: string): boolean {
  return (MENU_ACTIVATION_KEYS as readonly string[]).includes(key);
}

/** Handlers to spread on the element that wraps everything the menu renders. */
export function menuEventGuards(): Record<string, (e: never) => void> {
  const stop = (e: Stoppable) => e.stopPropagation();
  const guards: Record<string, (e: never) => void> = {};
  for (const name of MENU_POINTER_EVENTS) guards[name] = stop as (e: never) => void;
  const keyGuard = (e: KeyLike) => { if (swallowsKey(e.key)) e.stopPropagation(); };
  guards.onKeyDown = keyGuard as (e: never) => void;
  guards.onKeyUp = keyGuard as (e: never) => void;
  return guards;
}
