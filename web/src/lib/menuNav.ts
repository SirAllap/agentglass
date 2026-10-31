/*
 * Which row an arrow key lands on, for every menu in the Terminal.
 *
 * Up and Down wrap (the last row is one key above the first), Home and End go
 * to the ends. With nothing focused yet, Down takes the first row and Up the
 * last, which is what every native menu does.
 */
export type MenuKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export const isMenuKey = (k: string): k is MenuKey => k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End";

/** `at` is the focused row, or -1 when none is. -1 when there are no rows. */
export function menuIndex(at: number, key: MenuKey, n: number): number {
  if (n <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % n;
  return at <= 0 ? n - 1 : at - 1;
}
