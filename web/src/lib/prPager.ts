// Decisions about the pull-request list's pager, kept out of PrPanel.tsx so they
// can be tested without the component graph.

/**
 * Whether the Previous/Next footer is drawn.
 *
 * The board is two unpaginated lists of its own; a page number belongs to the
 * table. With the footer drawn under the board, "Page 2 of 2 · 22 total" sat
 * beneath a board that said nothing wanted anything from you, and the two read
 * as one contradictory answer. Ceiling: the board shows only the first page of
 * each queue it summarises; paging a queue is a table's job.
 */
export function pagerShown(o: { hasRepo: boolean; boardShown: boolean; hasNext: boolean; pageDepth: number }): boolean {
  return o.hasRepo && !o.boardShown && (o.hasNext || o.pageDepth > 0);
}

/**
 * Whether a page we are standing on has ceased to exist.
 *
 * The page stack survives opening a pull request and coming back, and the
 * list can shrink meanwhile (a pull request moved out of the scope leaves the
 * last page one row short, or empty). A cursor past the end answers with no rows
 * and no next page; nothing in the pager can leave it but Previous, so it is
 * taken back to page one instead of showing an empty table over a "22 total".
 */
export function pageRanOut(o: { pageDepth: number; rows: number; hasNext: boolean }): boolean {
  return o.pageDepth > 0 && o.rows === 0 && !o.hasNext;
}
