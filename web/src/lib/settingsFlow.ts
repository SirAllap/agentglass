/*
 * Where each card of a settings page sits: a column, a first grid row, a span.
 *
 * CSS `columns` re-balanced every time a card grew, so opening a disclosure
 * moved a neighbour to the other column. Here a card's column is fixed by its
 * position among the cards (round robin), the columns are independent stacks
 * and a card that grows pushes down only what is under it in its own column.
 * A wide card (a list, an editor, anything that is not a card) takes every
 * column and starts below the tallest one, so it is a barrier, as in a flow.
 *
 * Balance without drift: a card with no `col` goes to the shortest column at
 * the moment it is first seen (its height then), and the caller remembers that
 * column and passes it back as `col` from then on. Round robin left one column
 * far taller when the cards differ a lot (a 1900px list beside a 300px note).
 * A later card growing never reassigns anybody; one added later takes the
 * shortest column.
 *
 * Ceiling: the choice uses the height the card had when first seen, so a card
 * that grows a lot afterwards can unbalance the page again until it is remounted.
 */
/** The space under and between every card, in px; index.css `--agx-gap` is the same number. */
export const GAP = 18;
export interface FlowItem { h: number; wide: boolean; col?: number }
export interface FlowSlot { col: number | "all"; row: number; span: number }

export function placeFlow(items: readonly FlowItem[], cols: number): FlowSlot[] {
  const n = Math.max(1, Math.floor(cols));
  const y = new Array<number>(n).fill(0);
  return items.map((it) => {
    const span = Math.max(1, Math.ceil(it.h));
    if (it.wide || n === 1) {
      const row = Math.max(...y);
      y.fill(row + span);
      return { col: "all" as const, row: row + 1, span };
    }
    const c = it.col !== undefined && it.col >= 1 && it.col <= n ? it.col - 1 : y.indexOf(Math.min(...y));
    const row = y[c]!;
    y[c] = row + span;
    return { col: c + 1, row: row + 1, span };
  });
}
