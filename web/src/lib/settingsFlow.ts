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
 * Ceiling: round robin does not balance the two stacks; a page whose cards are
 * all tall on one side stays lopsided until a card is marked wide.
 */
export interface FlowItem { h: number; wide: boolean }
export interface FlowSlot { col: number | "all"; row: number; span: number }

export function placeFlow(items: readonly FlowItem[], cols: number): FlowSlot[] {
  const n = Math.max(1, Math.floor(cols));
  const y = new Array<number>(n).fill(0);
  let k = 0;
  return items.map((it) => {
    const span = Math.max(1, Math.ceil(it.h));
    if (it.wide || n === 1) {
      const row = Math.max(...y);
      y.fill(row + span);
      return { col: "all" as const, row: row + 1, span };
    }
    const c = k++ % n;
    const row = y[c]!;
    y[c] = row + span;
    return { col: c + 1, row: row + 1, span };
  });
}
