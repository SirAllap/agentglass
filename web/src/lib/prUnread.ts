// Which pull requests have been spoken on since you last looked — from the LIST.
//
// The conversation panel has answered this for one pull request for a while, and
// it answers it from the full detail: threads, comments, reviews, one GraphQL
// walk each. A board of twelve cards cannot ask twelve of those, and the case
// this is for is the one where you have not opened the pull request at all —
// "which of these has something waiting in it" is the question you ask BEFORE
// deciding what to open.
//
// So the row carries the tail of its own conversation (see PrTalk) and the
// counting happens here, against the same marks the panel writes: one timestamp
// per pull request in this browser (prNew.ts). Opening a pull request and
// leaving it moves that mark, so the badge goes out on the board behind you.
//
// The two counts agree on purpose. Everything the panel would count is counted
// here — a review's line comments individually, a bare "commented" review not at
// all — because a card saying "2 new" over a conversation that then marks three
// is a card nobody believes twice.

import type { PrSummary, PrTalk } from "../../../shared/types.ts";
import { at, prSeenKey, readSeen } from "./prNew.ts";

/** What a card says, and enough of why to put it on the tooltip. */
export interface Unread {
  /** Remarks, counted the way the conversation counts them. */
  count: number;
  /** Who said the newest one. */
  who: string;
  /** Everybody with something unread on it, newest speaker first. */
  people: string[];
  /** The newest review verdict among them, when one of them was a review — the
   *  difference between "somebody commented" and "somebody blocked this". */
  state?: PrTalk["state"];
  /** When the newest one arrived, ISO. */
  at: string;
}

/**
 * How much there is to read in one remark.
 *
 * A review is one entry carrying up to a hundred: `lines` is how many line
 * comments arrived in that batch, and the conversation lists each of them. A
 * review that only exists to carry them (`says` false — see mapTalk) is not
 * itself something to read, or every batch of three would count as four.
 */
export function weightOf(t: PrTalk): number {
  const lines = t.lines ?? 0;
  if (t.kind === "review") return lines + (t.says ? 1 : 0);
  return 1;
}

/**
 * The mark to count against, for a row this browser has never opened.
 *
 * The same fallback the conversation uses, and for the same reason: the pull
 * request you have never opened is exactly the one with no mark, so "nothing is
 * new until you have been here once" makes the feature introduce itself by doing
 * nothing. Everything after your own last word on it is, by definition, the part
 * you have not answered.
 *
 * Zero when you have never spoken on it either — which is honest. A pull request
 * you have never opened and never commented on is not "eleven unread", it is one
 * you have not started.
 */
export function bootstrapMark(talk: PrTalk[]): number {
  let mine = 0;
  for (const t of talk) if (t.mine) mine = Math.max(mine, at(t.at));
  return mine;
}

/**
 * What is unread on this row, or null for "nothing to say".
 *
 * Null covers three different situations on purpose, because a card treats them
 * identically — it draws nothing:
 *
 *   no talk yet     the list's second pass has not landed. An absent answer is
 *                   not an empty one, and a badge that appears a second after
 *                   the card does is a board that moves while you read it.
 *   no mark         never looked, never spoke. See bootstrapMark.
 *   nothing new     the ordinary case.
 */
export function unreadOf(
  pr: Pick<PrSummary, "number" | "talk">,
  repoKey: string | undefined,
  seen: Record<string, number> = readSeen(),
): Unread | null {
  const talk = pr.talk;
  if (!talk?.length) return null;
  const mark = seen[prSeenKey(repoKey, pr.number)] ?? bootstrapMark(talk);
  if (!mark) return null;
  /* Yours never counts. A remark you left is not something to go and find, and
     counting it lights the badge because you spoke. */
  const fresh = talk.filter((t) => !t.mine && at(t.at) > mark);
  if (!fresh.length) return null;
  const newestFirst = [...fresh].sort((a, b) => at(b.at) - at(a.at));
  const people: string[] = [];
  for (const t of newestFirst) if (t.who && !people.includes(t.who)) people.push(t.who);
  const verdict = newestFirst.find((t) => t.state && t.state !== "COMMENTED")
    ?? newestFirst.find((t) => t.kind === "review");
  return {
    count: fresh.reduce((n, t) => n + weightOf(t), 0),
    who: newestFirst[0]!.who,
    people,
    ...(verdict?.state ? { state: verdict.state } : null),
    at: newestFirst[0]!.at,
  };
}

/** The badge's own sentence, for its tooltip. Says who and what, because
 *  "2 new" tells you to go and look without telling you whether you need to. */
export function unreadTitle(u: Unread): string {
  const what = u.count === 1 ? "1 new remark" : `${u.count} new remarks`;
  const who = u.people.length === 1 ? u.people[0]
    : `${u.people.slice(0, 3).join(", ")}${u.people.length > 3 ? ` +${u.people.length - 3}` : ""}`;
  const verdict = u.state === "CHANGES_REQUESTED" ? " — changes requested"
    : u.state === "APPROVED" ? " — approved"
    : u.state === "DISMISSED" ? " — a review was dismissed" : "";
  return `${what} since you last looked, from ${who}${verdict}`;
}
