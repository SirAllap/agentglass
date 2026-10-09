// The review history of a pull request as one story per reviewer.
//
// The merge box's history was a flat list of reviews, newest first. Round one
// read exactly like round three, a re-request was a flag with no time on it, and
// nothing said that a later approval had closed an earlier request for changes.
// This is the same facts (the reviews, the timeline's review_requested events,
// who is still outstanding) folded into one group per reviewer, so every
// sentence the screen says is a row of one table-driven test.
//
// GitHub's rule, kept true in the wording: a COMMENTED review does NOT clear an
// earlier CHANGES_REQUESTED, so a comment never marks a round as past. Only a
// later APPROVED or a newer CHANGES_REQUESTED by the same person replaces one.
// A dismissed review is not a round here, as in the list this replaces.
//
// What it does not know: the moment a review was dismissed (GitHub rewrites the
// state in place and keeps the submit time), and who "you" is when the viewer
// did not open the pull request (the API gives no viewer login on this fetch),
// so an ask by anybody else carries their login.

import type { PrEvent, PrReview } from "./types.ts";

export type StoryVerdict = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
/** What the header chip says about the reviewer right now. */
export type StoryStanding = StoryVerdict | "ASKED_AGAIN";

/** The review that replaced a round. */
export interface StoryReplacement {
  by: "approval" | "changes";
  at: string;
  url?: string;
  nodeId?: string;
}

export type StoryEntry =
  | {
      kind: "review";
      at: string;
      state: StoryVerdict;
      url?: string;
      nodeId?: string;
      /** Set when a later review by the same person replaced this round. */
      replaced?: StoryReplacement;
      sentence: string;
    }
  | {
      kind: "ask";
      at: string;
      /** "you" when the viewer made the request, otherwise the actor's login. */
      actor: string;
      /** No review from them since. */
      waiting: boolean;
      sentence: string;
    };

export interface StoryGroup {
  login: string;
  standing: StoryStanding;
  /** The plain line on the right of the header. */
  line: string;
  /** Oldest first. */
  entries: StoryEntry[];
}

export interface StoryInput {
  reviews?: PrReview[];
  timeline?: PrEvent[];
  /** Logins still outstanding on the pull request (teams already dropped). */
  pending?: string[];
  /** The pull request's own author: their replies are not a round. */
  author?: string;
  /** Set to the author's login when the viewer opened the pull request, so a
   *  re-request they made reads "you". */
  you?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lc = (s: string | undefined | null): string => (s ?? "").toLowerCase();
const pad = (n: number): string => String(n).padStart(2, "0");

/** "20h", "3d" — a span with no direction. Under a minute and a half is "just now". */
export function span(from: string, now: number): string {
  const s = Math.max(0, (now - new Date(from).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "3d ago", and "just now" without a suffix. */
export function relative(from: string, now: number): string {
  const s = span(from, now);
  return s === "just now" ? s : `${s} ago`;
}

/** "Sep 27 · 14:05", in the machine's own time zone, as the timestamps beside it are. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isVerdict = (s: string): s is StoryVerdict => s === "APPROVED" || s === "CHANGES_REQUESTED" || s === "COMMENTED";

export function buildReviewStory(i: StoryInput, now = Date.now()): StoryGroup[] {
  const authorLc = lc(i.author);
  const pending = new Set((i.pending ?? []).map(lc));
  const timeline = i.timeline ?? [];

  const byLogin = new Map<string, { login: string; reviews: (PrReview & { state: StoryVerdict })[] }>();
  const sorted = [...(i.reviews ?? [])]
    .filter((r) => !r.isBot && lc(r.author) !== authorLc && isVerdict(r.state))
    .sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
  for (const r of sorted) {
    const k = lc(r.author);
    const g = byLogin.get(k) ?? { login: r.author, reviews: [] };
    g.reviews.push(r as PrReview & { state: StoryVerdict });
    byLogin.set(k, g);
  }

  const groups: StoryGroup[] = [];
  for (const [k, g] of byLogin) {
    const rs = g.reviews;
    const firstAt = rs[0]!.submittedAt;

    // Re-requests: only the ones made after this person had already reviewed.
    // An ask that a later review answered stays; one nobody answered stays only
    // while GitHub still lists them as outstanding; a removal in between voids it.
    const events = timeline.filter((e) => lc(e.detail) === k && (e.kind === "review-requested" || e.kind === "review-request-removed"));
    let asks = events.filter((e) => e.kind === "review-requested" && e.at > firstAt).filter((e) => {
      const nextReview = rs.find((r) => r.submittedAt > e.at);
      const removed = events.some((x) => x.kind === "review-request-removed" && x.at > e.at && (!nextReview || x.at < nextReview.submittedAt));
      if (removed) return false;
      return nextReview ? true : pending.has(k);
    });
    // Several asks with no review between them are one ask; the last is the live one.
    asks = asks.filter((e, idx) => {
      const nx = asks[idx + 1];
      return !(nx && !rs.some((r) => r.submittedAt > e.at && r.submittedAt < nx.at));
    });

    const verdicts = rs.filter((r) => r.state !== "COMMENTED");
    const lastVerdict = verdicts[verdicts.length - 1];
    const standing: StoryVerdict = lastVerdict ? lastVerdict.state : "COMMENTED";
    const lastAsk = asks[asks.length - 1];
    const waitingAsk = lastAsk && !rs.some((r) => r.submittedAt > lastAsk.at) ? lastAsk : undefined;
    const askedAgain = pending.has(k);
    const commentedSince = standing === "CHANGES_REQUESTED" && rs.some((r) => r.state === "COMMENTED" && r.submittedAt > lastVerdict!.submittedAt);

    const entries: StoryEntry[] = [];
    rs.forEach((r) => {
      const next = verdicts.find((v) => v.submittedAt > r.submittedAt);
      const replaced: StoryReplacement | undefined = r.state !== "COMMENTED" && next
        ? { by: next.state === "APPROVED" ? "approval" : "changes", at: next.submittedAt, url: next.url, nodeId: next.nodeId }
        : undefined;
      const prior = verdicts.filter((v) => v.submittedAt < r.submittedAt).pop();
      const followed = asks.some((a) => a.at > r.submittedAt && !rs.some((x) => x.submittedAt > r.submittedAt && x.submittedAt < a.at && x.state !== "COMMENTED"));
      let sentence: string;
      if (replaced) {
        sentence = `Replaced by ${replaced.by === "approval" ? "approval" : "a newer request for changes"} · ${stamp(replaced.at)}`;
      } else if (r.state === "CHANGES_REQUESTED") {
        sentence = waitingAsk && waitingAsk.at > r.submittedAt ? "re-requested below, no answer yet"
          : commentedSince ? "still stands: a comment does not clear it"
          : "changes requested, still open";
      } else if (r.state === "APPROVED") {
        sentence = prior?.state === "CHANGES_REQUESTED" ? "closes the round above"
          : prior?.state === "APPROVED" ? "approved again"
          : followed && waitingAsk ? "approved; asked again below" : "approved";
      } else {
        sentence = standing === "CHANGES_REQUESTED" ? "comment only, changes above still stand" : "comment only";
      }
      entries.push({ kind: "review", at: r.submittedAt, state: r.state, url: r.url, nodeId: r.nodeId, replaced, sentence });
    });
    asks.forEach((a) => {
      const waiting = a === waitingAsk;
      const you = i.you && lc(a.actor) === lc(i.you);
      const actor = you ? "you" : a.actor;
      entries.push({
        kind: "ask", at: a.at, actor, waiting,
        sentence: waiting ? `waiting on ${g.login}` : `${you ? "" : `${a.actor} `}asked ${g.login} to look again`,
      });
    });
    // Oldest first; a review and an ask at the same instant keep the review first.
    entries.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === "review" ? -1 : 1));

    let line: string;
    if (askedAgain) {
      const what = standing === "CHANGES_REQUESTED" ? "changes still stand" : standing === "APPROVED" ? "approval stands" : "";
      const wait = waitingAsk ? `waiting ${span(waitingAsk.at, now)}` : "waiting";
      line = what ? `${what}, ${wait}` : wait;
    } else if (standing === "APPROVED") {
      line = `${verdicts.some((v) => v.state === "CHANGES_REQUESTED") ? "resolved" : "approved"} ${relative(lastVerdict!.submittedAt, now)}`;
    } else if (standing === "CHANGES_REQUESTED") {
      line = commentedSince ? "still blocking, commented since" : "still blocking";
    } else {
      line = `commented ${relative(rs[rs.length - 1]!.submittedAt, now)}`;
    }

    groups.push({ login: g.login, standing: askedAgain ? "ASKED_AGAIN" : standing, line, entries });
  }

  // Oldest story first, the order the rounds arrived in.
  return groups.sort((a, b) => a.entries[0]!.at.localeCompare(b.entries[0]!.at));
}
