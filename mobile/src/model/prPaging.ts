/*
 * A refresh of the pull request list that keeps the pages already loaded.
 *
 * A live tick, the loading retry and a pull-to-refresh all re-read the FIRST
 * page. Replacing the list with it dropped every page "Load 20 more" had
 * appended, under the reader's thumb. The fresh page wins for what it names;
 * what lies beyond it stays.
 *
 * The smaller thing this cannot do: a row that moved from the first page to
 * the second because a new pull request arrived above it is dropped until the
 * next "Load more", and a list that shrank under the loaded tail keeps the
 * tail. Both are cheaper than keeping a pull request that has left the list.
 */
export interface PagedGroup<T extends { number: number }> {
  items: T[];
  total?: number;
  hasNext?: boolean;
  cursor?: string | null;
}

export function mergeFreshGroup<T extends { number: number }, G extends PagedGroup<T>>(was: G | undefined, fresh: G): G {
  // Same end-of-page cursor: nothing beyond page one was loaded.
  if (!was || (was.cursor ?? null) === (fresh.cursor ?? null)) return fresh;
  // No more rows than the fresh page: no later page was appended, so what was
  // known about paging is only what the first answer guessed. A cold list is
  // answered before GitHub has said whether a second page exists (no cursor),
  // and keeping that hid "Load more" for good. The reverse holds too: a fresh
  // answer that is itself cold (no total) knows nothing about paging, and does
  // not get to erase a cursor that was known.
  if (was.items.length <= fresh.items.length && fresh.total !== undefined) return fresh;
  const now = new Map(fresh.items.map((p) => [p.number, p] as const));
  const had = new Set(was.items.map((p) => p.number));
  const items = [
    ...fresh.items.filter((p) => !had.has(p.number)),
    ...was.items.flatMap((p, i) => (now.has(p.number) ? [now.get(p.number)!] : i >= fresh.items.length ? [p] : [])),
  ];
  return { ...fresh, items, total: fresh.total ?? was.total, hasNext: was.hasNext, cursor: was.cursor };
}

/** Each fresh repository merged with the same repository as it was loaded. */
export function mergeFresh<T extends { number: number }, G extends PagedGroup<T> & { root: string }>(
  was: readonly G[] | null, fresh: readonly G[],
): G[] {
  return fresh.map((g) => mergeFreshGroup<T, G>(was?.find((w) => w.root === g.root), g));
}

/**
 * How many rows the next press of "Load more" brings, for its label.
 *
 * A page is `pageSize` a repository, so a list of 22 said "Load 20 more" and
 * then brought two. Where the server told us the total, the label says what is
 * left; where it did not (a cold answer), it says a page, as it always did.
 */
export function nextPageCount(groups: readonly PagedGroup<{ number: number }>[], pageSize: number): number {
  const more = groups.filter((g) => g.hasNext);
  if (more.some((g) => g.total === undefined)) return pageSize;
  const left = more.reduce((n, g) => n + Math.max(0, (g.total ?? 0) - g.items.length), 0);
  return left > 0 ? Math.min(left, more.length * pageSize) : pageSize;
}
