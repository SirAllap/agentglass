// "What has moved since I reviewed this."
//
// The question a second pass at a pull request opens with. You approved or asked for
// changes against a commit; the author pushed twice; you come back to forty files of
// which three are new to you, and nothing on screen knows which three — so the whole
// review happens again. GitHub answers this with "changes since your last review";
// this is the same question asked of data the panel already has.
//
// The commit each review was written against travels on `PrReview.commit` (it has
// since the review payload was first written, for exactly this reason), so the only
// thing to work out here is WHICH review counts as yours and against what to compare
// it. Both of those have a wrong answer that looks right, which is why they live in a
// tested function rather than in a component.

import type { PrDetail, PrReview } from "../../../shared/types.ts";

/**
 * The review to measure from: your own latest SUBMITTED one that names a commit.
 *
 * Three exclusions, and each one is a way of being wrong:
 *
 *   somebody else's   the mark is about what YOU have read.
 *   pending           a review you are still writing was written against the code in
 *                     front of you; "since" it is nothing.
 *   no commit         an older payload, or a review GitHub did not attach to a
 *                     commit. Without one there is nothing to compare against, and a
 *                     guess would silently measure from the wrong place.
 */
export function myLastReview(d: Pick<PrDetail, "reviews"> | null | undefined): PrReview | null {
  let best: PrReview | null = null;
  for (const r of d?.reviews ?? []) {
    if (!r.viewerDidAuthor || r.state === "PENDING" || !r.commit) continue;
    if (!best || Date.parse(r.submittedAt || "") >= Date.parse(best.submittedAt || "")) best = r;
  }
  return best;
}

/**
 * What to compare, or null when the question does not apply.
 *
 * Null in three cases that are all "no mark", and the third is the one worth naming:
 * when the pull request has not moved since the review, the honest answer is not
 * "nothing changed" drawn as an empty filter — it is no filter at all, because a
 * control that selects nothing reads as broken.
 */
export function sinceRange(d: PrDetail | null | undefined): { from: string; to: string } | null {
  if (!d) return null;
  const mine = myLastReview(d);
  if (!mine?.commit) return null;
  const head = d.headSha || d.commits[d.commits.length - 1]?.oid || "";
  if (!head || head === mine.commit) return null;
  return { from: mine.commit, to: head };
}

/** The tooltip. Says what it measures AND what it cannot know, because a mark on a
 *  list of files has to be trusted to be used. */
export function sinceTitle(o: { count: number; from: string; when?: string; missing?: boolean; on: boolean }): string {
  if (o.missing) {
    return `The commit you reviewed (${o.from.slice(0, 7)}) is not in this checkout, so nothing can be compared.`
      + " Fetch the branch and it will be.";
  }
  if (o.count === 0) return `Nothing has changed since your review of ${o.from.slice(0, 7)}.`;
  const what = `${o.count} ${o.count === 1 ? "file has" : "files have"} changed since your review`
    + `${o.when ? ` of ${o.when}` : ""} (${o.from.slice(0, 7)})`;
  return o.on
    ? `${what}. Showing only those — press again for all of them.`
    : `${what}. Press to show only those.`
      + " A trunk merge into the branch counts as change, because those files really are new to the branch since you looked.";
}
