/**
 * Who a pull request can ask for a review.
 *
 * GitHub refuses to request a review from the person who opened the pull
 * request: its own picker does not list them. Listing them here anyway meant a
 * click that did nothing and said nothing, so the author is left out of the
 * candidates.
 */
export function withoutAuthor<T extends { value: string }>(options: T[], author: string | undefined): T[] {
  const a = (author ?? "").trim().toLowerCase();
  return a ? options.filter((o) => o.value.trim().toLowerCase() !== a) : options;
}

