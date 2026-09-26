/*
 * Adding one repository's filter counts to another's.
 *
 * Its own function because the reduce it replaced had no initial value —
 * `answers.reduce((sum, c) => ({ ... }))` folds the FIRST element in as the
 * seed, which is right by luck (every element has the same shape) and wrong
 * by habit: an empty list would throw instead of answering "nothing to add".
 * Pulled out so the empty case, and the sum itself, are asserted against
 * source rather than against a screen — there is no renderer in this project.
 */

/** What `/prs/counts` answers with, per repository. */
export interface PrViewCounts { review: number; mine: number; failing: number; ready: number; all: number }

const ZERO: PrViewCounts = { review: 0, mine: 0, failing: 0, ready: 0, all: 0 };

/** Null for an empty list — "nobody answered yet" is not the same fact as
 *  "everybody answered zero", and the caller keeps the old counts on screen
 *  for the first, same as it always has for the second. */
export function sumPrCounts(counts: PrViewCounts[]): PrViewCounts | null {
  if (!counts.length) return null;
  return counts.reduce((sum, c) => ({
    review: sum.review + c.review,
    mine: sum.mine + c.mine,
    failing: sum.failing + c.failing,
    ready: sum.ready + c.ready,
    all: sum.all + c.all,
  }), ZERO);
}
