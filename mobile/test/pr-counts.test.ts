/*
 * "Review 0 · Mine 0 · All 0" stayed on screen over a list showing seven
 * pull requests: the counters were asked once, on the effect keyed to
 * `[host, shown, view]`, and never again — a pull-to-refresh and the live
 * tick both re-read the list without moving any of those three. The counts
 * are re-asked on the same signals now (prs.tsx), and this is the pure part
 * of that fix: summing what came back, and telling "nobody answered" apart
 * from "everybody answered zero" so the caller knows when to keep the old
 * numbers rather than blank the row.
 */
import { describe, expect, test } from "bun:test";
import { sumPrCounts, type PrViewCounts } from "../src/model/prCounts.ts";

const counts = (over: Partial<PrViewCounts>): PrViewCounts =>
  ({ review: 0, mine: 0, failing: 0, ready: 0, all: 0, ...over });

describe("sumPrCounts", () => {
  test("adds one repository's counts to another's", () => {
    expect(sumPrCounts([
      counts({ review: 2, mine: 1, all: 7 }),
      counts({ review: 1, failing: 3, all: 4 }),
    ])).toEqual(counts({ review: 3, mine: 1, failing: 3, all: 11 }));
  });

  test("a single repository is not folded into itself twice", () => {
    expect(sumPrCounts([counts({ review: 5, all: 5 })])).toEqual(counts({ review: 5, all: 5 }));
  });

  test("nothing answering yet is null, not a row of zeros", () => {
    expect(sumPrCounts([])).toBeNull();
  });
});
