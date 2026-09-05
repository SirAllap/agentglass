/*
 * "What has moved since I reviewed this."
 *
 * The two decisions here both have a wrong answer that looks right — which review
 * counts as yours, and what to compare it against — and both of them fail silently:
 * a mark measured from the wrong commit does not throw, it just quietly tells a
 * reviewer that a file is safe to skip.
 */
import { describe, expect, it } from "bun:test";
import type { PrDetail, PrReview } from "../../shared/types.ts";
import { myLastReview, sinceRange, sinceTitle } from "../src/lib/prSinceReview.ts";

const review = (over: Partial<PrReview>): PrReview => ({
  author: "javidoe", isBot: false, state: "COMMENTED", body: "", submittedAt: "2026-08-10T09:00:00Z",
  url: "", nodeId: "", commit: "a".repeat(40), ...over,
} as PrReview);

const detail = (over: Partial<PrDetail>): PrDetail => ({
  number: 1, reviews: [], commits: [], headSha: "", ...over,
} as unknown as PrDetail);

describe("which review is the mark", () => {
  it("is your own latest submitted one", () => {
    const d = detail({ reviews: [
      review({ viewerDidAuthor: true, submittedAt: "2026-08-10T09:00:00Z", commit: "1".repeat(40) }),
      review({ viewerDidAuthor: true, submittedAt: "2026-08-12T09:00:00Z", commit: "2".repeat(40) }),
    ] });
    expect(myLastReview(d)?.commit).toBe("2".repeat(40));
  });

  it("never somebody else's", () => {
    const d = detail({ reviews: [review({ viewerDidAuthor: false })] });
    expect(myLastReview(d)).toBeNull();
  });

  // A review you are still writing was written against the code in front of you.
  it("never one you have not submitted", () => {
    const d = detail({ reviews: [review({ viewerDidAuthor: true, state: "PENDING" })] });
    expect(myLastReview(d)).toBeNull();
  });

  // Without a commit there is nothing to measure from, and a guess would measure
  // from the wrong place without saying so.
  it("never one with no commit on it", () => {
    const d = detail({ reviews: [review({ viewerDidAuthor: true, commit: "" })] });
    expect(myLastReview(d)).toBeNull();
  });
});

describe("what gets compared", () => {
  it("your reviewed commit against the head", () => {
    const d = detail({
      reviews: [review({ viewerDidAuthor: true, commit: "1".repeat(40) })],
      headSha: "9".repeat(40),
    });
    expect(sinceRange(d)).toEqual({ from: "1".repeat(40), to: "9".repeat(40) });
  });

  it("falls back to the last commit when the head sha has not arrived", () => {
    const d = detail({
      reviews: [review({ viewerDidAuthor: true, commit: "1".repeat(40) })],
      commits: [{ oid: "7".repeat(40) }, { oid: "8".repeat(40) }] as PrDetail["commits"],
    });
    expect(sinceRange(d)?.to).toBe("8".repeat(40));
  });

  // Nothing to show is NOT an empty filter: a control that selects nothing reads as
  // broken, so the range is null and the chip does not appear at all.
  it("is nothing when the pull request has not moved since the review", () => {
    const same = "5".repeat(40);
    const d = detail({ reviews: [review({ viewerDidAuthor: true, commit: same })], headSha: same });
    expect(sinceRange(d)).toBeNull();
  });

  it("is nothing when there is no review of yours", () => {
    expect(sinceRange(detail({ headSha: "9".repeat(40) }))).toBeNull();
    expect(sinceRange(null)).toBeNull();
  });
});

describe("what the chip says", () => {
  it("names the count and what a press will do", () => {
    const t = sinceTitle({ count: 3, from: "abc1234def", on: false });
    expect(t).toContain("3 files have changed since your review");
    expect(t).toContain("abc1234");
    expect(t).toContain("Press to show only those");
  });

  it("says how to get back out when it is on", () => {
    expect(sinceTitle({ count: 3, from: "abc1234def", on: true })).toContain("press again for all");
  });

  // The one thing that would make the mark a lie if it went unsaid.
  it("admits that a trunk merge counts as change", () => {
    expect(sinceTitle({ count: 3, from: "abc1234def", on: false })).toContain("trunk merge");
  });

  it("says plainly when the reviewed commit is not in this checkout", () => {
    const t = sinceTitle({ count: 0, from: "abc1234def", missing: true, on: false });
    expect(t).toContain("not in this checkout");
    expect(t).toContain("Fetch");
  });

  it("and says nothing moved rather than showing a zero", () => {
    expect(sinceTitle({ count: 0, from: "abc1234def", on: false })).toBe("Nothing has changed since your review of abc1234.");
  });
});
