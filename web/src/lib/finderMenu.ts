/*
 * The highlighted row of a menu, as Strata's popovers draw it: the row under
 * the pointer and the row the arrow keys are on are the same thing, one
 * rounded, quiet fill, and a menu with nothing highlighted yet starts at its
 * first row on Down and its last on Up.
 */

export const MENU_ROW = "agx-menu-row";
export type MenuKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** The row to highlight next among `count` enabled rows, `cur` being the one highlighted now (-1 for none). Wraps at both ends, as a GTK menu does. */
export function stepActive(count: number, cur: number, key: MenuKey): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (cur < 0 || cur >= count) return key === "ArrowDown" ? 0 : count - 1;
  return key === "ArrowDown" ? (cur + 1) % count : (cur - 1 + count) % count;
}

/** Strata's menu dividers are a hint, not a line: fainter than the finder's own hairline. */
export const MENU_RULE = "1px solid color-mix(in srgb, var(--border) 40%, transparent)";
/** A row is 25 px tall and the 1 px margins between rows collapse into one: the 26 px pitch Strata's menus keep. */
export const MENU_ROW_H = 25;
/** The column sort menu is the one Strata draws with roomy 38 px rows. */
export const MENU_ROW_TALL = 37;
