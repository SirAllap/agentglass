/*
 * Which cards are picked for a bulk action, apart from the screen so `x` and the bulk bar can both be tested: a set of
 * card ids, never the card open in the dock (that is `selectedId`, a different thing). `x` toggles one id in or out;
 * the bulk bar's own Clear, or Escape, empties the set.
 */

export type Selection = ReadonlySet<string>;
export const EMPTY_SELECTION: Selection = new Set();

/** One id in or out of the set. A fresh Set every time, so React sees the change. */
export function toggleSelected(ids: Selection, id: string): Selection {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** The set a Ctrl/Shift+click starts from: when nothing is picked yet and another card is open in the dock, that open
 *  card joins first. It wears the same accent border as a picked card, so leaving it out made "two picked" one. */
export function seedWithOpen(ids: Selection, openId: string | null | undefined, clicked: string): Selection {
  if (ids.size || !openId || openId === clicked) return ids;
  return new Set([openId]);
}
