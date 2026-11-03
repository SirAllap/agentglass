/**
 * The picked hashes in log order (newest first), whatever order they were
 * clicked in; null when one is not in the loaded log. Squash and cherry-pick
 * need the order of history, not of the clicks.
 */
export function orderPicked(picked: Iterable<string>, commits: readonly string[]): string[] | null {
  const idx: number[] = [];
  for (const h of picked) {
    const i = commits.indexOf(h);
    if (i < 0) return null;
    idx.push(i);
  }
  return idx.sort((a, b) => a - b).map((i) => commits[i]);
}

/** The badge on each picked row: 1 for the oldest, as the commits will be
 *  applied. null when a pick is not in the loaded log. */
export function pickNumbers(picked: Iterable<string>, commits: readonly string[]): Map<string, number> | null {
  const o = orderPicked(picked, commits);
  return o && new Map(o.slice().reverse().map((h, i) => [h, i + 1]));
}

/** Newest-first picks are a squashable run when they are adjacent and the
 *  newest is the tip (index 0). */
export const isRunToTip = (ordered: readonly string[], commits: readonly string[]): boolean =>
  ordered.length >= 2 && ordered.every((h, k) => commits.indexOf(h) === k);
