/**
 * The conversation in the order github.com draws it.
 *
 * GitHub's timeline is one list, oldest first, of everything that happened:
 * a remark on the pull request, a review, a push, a label, a review request.
 * A review carries the line threads it was submitted with, nested under it,
 * and that is where they stay — a reply three days later does not lift the
 * thread out of its review, and resolving it only folds it shut in its slot.
 *
 * This used to be decided in the panel, and decided differently: a thread
 * answered after its review was pulled out to the top level and sorted by
 * its last reply, and a thread from an automation's review was never nested at
 * all. The effect was a page that reshuffled itself — a review's reasons
 * scattered below it, and a thread that jumped when it was resolved. Where a
 * reply is new is what the "new since you last looked" bar is for; the order
 * is GitHub's.
 *
 * Nothing here asks GitHub for anything: every input is already on the detail
 * the server returns. The one fact the detail lacks is which review a thread
 * was submitted with (it would be `pullRequestReview{id}` on the thread's first
 * comment), and it is recovered from what is there instead — see `ownerOf`.
 */
import type { PrComment, PrCommit, PrDetail, PrEvent, PrReview, PrThread } from "../../../shared/types.ts";
import { reviewSpeaks } from "../../../shared/prConversation.ts";

/** Whose voice an item is — the conversation's Humans / Bots filter reads it. */
export type TimelineLane = "human" | "bot" | "event";

export type TimelineItem =
  /** A review, with the threads it opened. A review that says nothing of its
   *  own and opened no thread is not an item — see `reviewShows`. */
  | { kind: "review"; key: string; ms: number; lane: TimelineLane; review: PrReview; threads: PrThread[] }
  /** A thread whose review is not on the detail: a draft of your own, or one
   *  whose review fell outside the page of reviews the server reads. */
  | { kind: "thread"; key: string; ms: number; lane: TimelineLane; thread: PrThread }
  | { kind: "comment"; key: string; ms: number; lane: TimelineLane; comment: PrComment }
  | { kind: "event"; key: string; ms: number; lane: "event"; event: PrEvent }
  /** Commits with nothing else between them — GitHub's "added N commits". */
  | { kind: "commits"; key: string; ms: number; lane: "event"; commits: PrCommit[] };

const at = (iso: string | null | undefined): number => {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * How far before its review a thread's first comment may be stamped and still
 * count as that review's. Automation and "Add single comment" write the comment
 * and submit the review in the same request, and the two stamps are not always
 * the same second; a person's draft is written first and submitted later, which
 * the search forward from the comment already covers.
 */
export const REVIEW_SLACK_MS = 5_000;

/**
 * The review a thread was submitted with.
 *
 * A line comment is written into its author's pending review, and becomes
 * visible when that review is submitted — so the review that owns it is the
 * first review by the same author submitted at or after the comment was
 * written. There is only one pending review per author at a time, which is
 * what makes "the next one" the right one.
 *
 * Ceiling, named: a review outside the fetched page (the server reads the last
 * 60) cannot be found, and the thread then stands on its own at its first
 * comment. That is the same slot GitHub would give it to the minute.
 */
function ownerOf(t: PrThread, byAuthor: Map<string, PrReview[]>): PrReview | undefined {
  const first = t.comments[0];
  if (!first) return undefined;
  const from = at(first.createdAt) - REVIEW_SLACK_MS;
  for (const r of byAuthor.get(first.author) ?? []) if (at(r.submittedAt) >= from) return r;
  return undefined;
}

/**
 * Whether GitHub draws a review as an entry of its own.
 *
 * A reply on a line creates a `COMMENTED` review with no body, and GitHub does
 * not draw it — the reply is already inside its thread. A review that says
 * something, gives a verdict, or opened a thread is drawn.
 */
function reviewShows(r: PrReview, threads: number): boolean {
  return threads > 0 || reviewSpeaks(r);
}

/**
 * Everything on the conversation, in GitHub's order and GitHub's grouping.
 *
 * Position depends on when a thing was said, never on whether it has since
 * been resolved or answered: `isResolved` is a fold, not a place.
 */
export function prTimeline(d: Pick<PrDetail, "reviews" | "comments" | "threads" | "timeline" | "commits">): TimelineItem[] {
  const reviews = d.reviews.filter((r) => r.state !== "PENDING" && at(r.submittedAt) > 0)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => at(a.r.submittedAt) - at(b.r.submittedAt) || a.i - b.i)
    .map((x) => x.r);
  const byAuthor = new Map<string, PrReview[]>();
  for (const r of reviews) byAuthor.set(r.author, [...(byAuthor.get(r.author) ?? []), r]);

  const owned = new Map<PrReview, PrThread[]>();
  const loose: PrThread[] = [];
  for (const t of d.threads) {
    const r = ownerOf(t, byAuthor);
    if (r) owned.set(r, [...(owned.get(r) ?? []), t]);
    else loose.push(t);
  }

  /* Ties keep the order they were pushed in: a commit before the events it
     caused, and an event before the remark that answered it. */
  const flat: TimelineItem[] = [];
  for (const c of d.commits) {
    flat.push({ kind: "commits", key: `k${c.oid}`, ms: at(c.committedAt), lane: "event", commits: [c] });
  }
  for (const [i, e] of d.timeline.entries()) {
    flat.push({ kind: "event", key: `e${i}`, ms: at(e.at), lane: "event", event: e });
  }
  for (const c of d.comments) {
    flat.push({ kind: "comment", key: `c${c.id}`, ms: at(c.createdAt), lane: c.isBot ? "bot" : "human", comment: c });
  }
  for (const r of reviews) {
    const threads = (owned.get(r) ?? []).slice().sort((a, b) => at(a.comments[0]?.createdAt) - at(b.comments[0]?.createdAt));
    if (!reviewShows(r, threads.length)) continue;
    flat.push({
      kind: "review", key: `r${r.nodeId ?? `${r.author}-${r.submittedAt}`}`, ms: at(r.submittedAt),
      lane: r.isBot ? "bot" : "human", review: r, threads,
    });
  }
  for (const t of loose) {
    /* Whose voice, read off whoever OPENED the thread. It was once hard-coded
       to "human", and a pull request only automation had argued on counted
       eight people. A reply inside somebody else's thread is part of their
       remark, not one of your own. */
    flat.push({ kind: "thread", key: `t${t.id}`, ms: at(t.comments[0]?.createdAt), lane: t.comments[0]?.isBot ? "bot" : "human", thread: t });
  }

  const sorted = flat.map((x, i) => ({ x, i })).sort((a, b) => a.x.ms - b.x.ms || a.i - b.i).map((y) => y.x);

  // Commits that land back to back are one entry, the way GitHub prints a push.
  const out: TimelineItem[] = [];
  for (const x of sorted) {
    const prev = out[out.length - 1];
    if (x.kind === "commits" && prev?.kind === "commits") prev.commits.push(...x.commits);
    else out.push(x.kind === "commits" ? { ...x, commits: [...x.commits] } : x);
  }
  return out;
}
