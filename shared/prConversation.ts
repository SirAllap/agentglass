/*
 * The conversation of a pull request as one list, and who is in it.
 *
 * The desktop panel and the phone both answer "what was said, and by a person
 * or by automation", and a second copy of that answer is the one that drifts:
 * a phone counting a bare review that the desktop hides shows "Humans 4" where
 * the desktop says 3. So the rule lives here, without a screen in it.
 *
 * Deliberately smaller than the desktop timeline: no push or label events, and
 * a line thread is one entry (it is opened as a thread elsewhere) rather than
 * nested under the review it came with. Those are the next things after this
 * and are not here.
 */
import type { PrComment, PrDetail, PrReview, PrThread } from "./types.ts";

export type Lane = "all" | "humans" | "bots";

export type ConvEntry =
  | { kind: "comment"; key: string; at: number; isBot: boolean; comment: PrComment }
  | { kind: "review"; key: string; at: number; isBot: boolean; review: PrReview }
  | { kind: "thread"; key: string; at: number; isBot: boolean; thread: PrThread };

/**
 * Does this review actually say anything?
 *
 * GitHub records a review for every batch of line comments, so replying on one
 * line creates a `COMMENTED` review with an empty body — already on the page
 * inside its thread, and a card reading "(commented, no note)" under it is the
 * same remark drawn twice. Counting them made "3 new" sit over two visible
 * markers, so the counter and the list share this one test.
 */
export function reviewSpeaks(r: { body?: string; state?: string }): boolean {
  return !!(r.body?.trim() || (r.state && r.state !== "COMMENTED"));
}

const at = (iso: string | undefined): number => {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? ms : 0;
};

/** Everything said, oldest first. A thread is dated by its first remark. */
export function conversation(d: Pick<PrDetail, "comments" | "reviews" | "threads">): ConvEntry[] {
  const out: ConvEntry[] = [];
  for (const c of d.comments) {
    out.push({ kind: "comment", key: `comment-${c.id}`, at: at(c.createdAt), isBot: c.isBot, comment: c });
  }
  for (const [i, r] of d.reviews.entries()) {
    if (!reviewSpeaks(r)) continue;
    out.push({ kind: "review", key: `review-${i + 1}`, at: at(r.submittedAt), isBot: r.isBot, review: r });
  }
  for (const t of d.threads) {
    const first = t.comments[0];
    out.push({ kind: "thread", key: `thread-${t.id}`, at: at(first?.createdAt), isBot: !!first?.isBot, thread: t });
  }
  // Array.sort is stable, so entries at the same instant keep the order above.
  return out.sort((a, b) => a.at - b.at);
}

export function inLane(entries: ConvEntry[], lane: Lane): ConvEntry[] {
  if (lane === "all") return entries;
  return entries.filter((e) => e.isBot === (lane === "bots"));
}

export function countLanes(entries: ConvEntry[]): Record<Lane, number> {
  const bots = entries.filter((e) => e.isBot).length;
  return { all: entries.length, humans: entries.length - bots, bots };
}
