/*
 * How the cards of one lane are ordered.
 *
 * `default` is the order the board files them in and is returned untouched, so
 * a lane nobody sorted costs nothing and still reads as it always did.
 *
 * "Oldest" and "newest" go by `updatedAt`: a summary carries no creation date,
 * and a second request per card to learn one would break the board's budget.
 * What that cannot say is how long a pull request has existed; it says how long
 * it has been quiet, which is what a reviewer scanning a lane wants anyway.
 *
 * Stable: ties keep the filed order, so two pull requests with the same diff
 * size do not swap places on every refresh.
 */
import type { PrSummary } from "../../../shared/types.ts";

export const SORT_KEYS = ["default", "oldest", "newest", "diff", "failing"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = {
  default: "Default order",
  oldest: "Oldest update",
  newest: "Newest update",
  diff: "Biggest diff",
  failing: "Most failing checks",
};

const failures = (p: PrSummary) => p.checks?.failure ?? p.checks?.failing?.length ?? 0;
const size = (p: PrSummary) => (p.additions || 0) + (p.deletions || 0);
const when = (p: PrSummary) => {
  const t = Date.parse(p.updatedAt);
  return Number.isNaN(t) ? 0 : t;
};

export function sortCards<T extends PrSummary>(cards: readonly T[], key: SortKey): readonly T[] {
  if (key === "default") return cards;
  const by: Record<Exclude<SortKey, "default">, (p: T) => number> = {
    oldest: (p) => when(p),
    newest: (p) => -when(p),
    diff: (p) => -size(p),
    failing: (p) => -failures(p),
  };
  const f = by[key];
  return cards
    .map((p, i) => ({ p, i, k: f(p) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.p);
}
