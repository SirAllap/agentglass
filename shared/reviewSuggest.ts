/**
 * Which review prompt this pull request calls for.
 *
 * In `shared/` because two places need the same answer and a disagreement
 * between them is invisible: the menu marks one entry as the suggestion, and
 * the server picks one when the caller names none. Two copies of a rule with
 * six branches drift on the first change to either.
 *
 * A suggestion and never a filter. Every prompt is in the menu whatever this
 * returns — the situation that forced the whole feature was a pull request
 * reviewed twice and handed back a third time WITHOUT the reviewer being
 * re-requested, where `viewerRequested` is false and describes the wrong job.
 */

/** What the panel knows about a pull request when it draws the menu. */
export interface ReviewSituation {
  viewerDidAuthor: boolean;
  reviewDecision: string | null;
  viewerRequested: boolean;
  /** You have a review on it, and the head has moved since you wrote it. */
  movedSinceMyReview: boolean;
  /** How many reviews it has at all. Separates "nobody has looked yet" from
   *  "there are comments waiting for me". */
  reviewsSoFar?: number;
  /** Failing checks, or a conflict with the base. */
  blocked?: boolean;
  card?: string | null;
}

/**
 * An id rather than a category, because two prompts can be for the same day and
 * still not be interchangeable: on a pull request of mine that nobody has read
 * yet the useful move is to review it myself, and on the same one after four
 * comments it is to answer them.
 *
 * Ordered by how specific the claim is, not by how common. "Changes requested
 * on mine" is a decision somebody actually made; "I reviewed this and it has
 * moved" is a fact about two commits; "review requested" is a checkbox anyone
 * can forget — which is why it comes last among the ones about other people.
 */
export function suggestRecipeId(pr: ReviewSituation): string {
  if (pr.viewerDidAuthor) {
    if (pr.reviewDecision === "CHANGES_REQUESTED") return "address";
    if (pr.blocked) return "unblock";
    if (!pr.reviewsSoFar) return "self-review";
    return "reply";
  }
  if (pr.movedSinceMyReview) return "re-review";
  if (pr.viewerRequested) return "review-full";
  return "understand";
}
