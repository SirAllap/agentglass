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
