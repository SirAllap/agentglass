// Decisions about the pull-request list's pager, kept out of PrPanel.tsx so they
// can be tested without the component graph.

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
