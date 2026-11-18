/*
 * The frame the board is drawn in, as numbers one test can hold.
 *
 * The chrome around the lanes is the thing that ate this screen: a row for the
 * search field, a row for the Board/List switch, a line for "Refreshed", a
 * title row and a drawer inside every lane. None of those is wrong on its own;
 * together they left the cards half the frame. So the four heights the chrome
 * is allowed live here, the screens read them, and test/board-frame.test.ts
 * multiplies the same four back out — a number added to a style object cannot
 * pass without a test agreeing to it.
 */

/** The lane jump strip, drawn as the mock's `.lanestrip.one`. */
export const STRIP_H = 45;

/** The row of filters in force, drawn as the mock's `.factive`: 48, no air of
 *  its own. The saved views are inside the filter sheet (mock 30), not a row
 *  above the cards. */
export const VIEW_ROW_H = 48;

export const BOARD_FRAME = {
  /** The status bar, above a header the navigator draws. */
  statusBar: 24,
  /** The navigator's header: the computer's name and the header icons. */
  header: 56,
  /** The bar's own height above the gesture inset — see nav/TabBar.tsx. */
  nav: 52,
} as const;

/** What is left of a frame for the board, over what the frame was. */
export function boardShare({ height, inset, inFlow }: {
  height: number;
  /** The gesture/navigation inset the bar pays under itself. */
  inset: number;
  /** Everything above and below the scroll area, in points. */
  inFlow: number[];
}): number {
  const chrome = inFlow.reduce((n, h) => n + h, inset);
  return (height - chrome) / height;
}
