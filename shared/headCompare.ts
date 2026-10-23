/**
 * "Is this review about the commit the pull request is on?", answered in one
 * place for the server's summary and the web's header, so a card and a header
 * can never disagree.
 *
 * Three answers, not two: a review is stale only when BOTH commits are known
 * and differ, and the head was read AFTER the review finished. A head read
 * before the review ended says nothing about it: the review may have run on a
 * push the app has not seen yet (measured: a cached head one push behind made
 * every fresh review read "stale · head moved").
 */

const HEX = /^[0-9a-f]{7,40}$/i;

/** A pull request head and when the app read it (ms). `at` absent = the caller
 *  vouches for it, which only a test or a read made this instant should do. */
export interface HeadRead { sha?: string | null; at?: number | null }

/** null when either side is not a usable commit (7..40 hex); otherwise whether
 *  one is a prefix of the other, ignoring case. */
export function sameCommit(a?: string | null, b?: string | null): boolean | null {
  if (!a || !b || !HEX.test(a) || !HEX.test(b)) return null;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** true: the head moved after the review. false: same commit. null: cannot tell
 *  (a sha is missing, or the head was read before the review ended). */
export function reviewStale(reviewedSha: string | null | undefined, reviewedAt: number | null | undefined, head: HeadRead | string | null | undefined): boolean | null {
  const h: HeadRead = typeof head === "string" ? { sha: head } : head ?? {};
  const same = sameCommit(h.sha, reviewedSha);
  if (same === null) return null;
  if (same) return false;
  if (h.at != null && reviewedAt != null && h.at < reviewedAt) return null;
  return true;
}

/** The head is older than the review and differs: the one case where a fresh
 *  read of the head is what turns "cannot tell" into an answer. */
export function headNeedsRead(reviewedSha: string | null | undefined, reviewedAt: number | null | undefined, head: HeadRead | string | null | undefined): boolean {
  const h: HeadRead = typeof head === "string" ? { sha: head } : head ?? {};
  if (!reviewedSha || !HEX.test(reviewedSha)) return false;
  if (!h.sha) return true;
  return sameCommit(h.sha, reviewedSha) === false && h.at != null && reviewedAt != null && h.at < reviewedAt;
}
