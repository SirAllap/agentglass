/**
 * Who a pull request can ask for a review.
 *
 * GitHub refuses to request a review from the person who opened the pull
 * request: its own picker does not list them. Listing them here anyway meant a
 * click that did nothing and said nothing, so the author is left out of the
 * candidates, and the hint says why when the author is the person at the keys.
 */
export function withoutAuthor<T extends { value: string }>(options: T[], author: string | undefined): T[] {
  const a = (author ?? "").trim().toLowerCase();
  return a ? options.filter((o) => o.value.trim().toLowerCase() !== a) : options;
}

/** The line under the picker's title when the author would otherwise have been offered. */
export function authorLeftOutHint(author: string | undefined, viewerDidAuthor: boolean | undefined, listed: string[]): string | undefined {
  const a = (author ?? "").trim().toLowerCase();
  if (!a || !viewerDidAuthor) return undefined;
  return listed.some((u) => u.trim().toLowerCase() === a) ? "You opened this pull request, so GitHub does not let you review it" : undefined;
}
