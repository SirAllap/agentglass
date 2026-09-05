// Being told when a person says something on a pull request of yours.
//
// GitHub's own answer to this is an inbox and an email. Neither reaches somebody
// working fullscreen in this app — the same reason the notch exists at all — and
// the specific thing that goes missing is the one worth interrupting for: a
// review coming back, and whether it came back as an approval or as changes
// requested.
//
// The server derives these from the list poll it already runs and holds the
// latch, so what arrives here is one message per pull request per poll, and never
// a machine. Everything left to decide on this side is how much of it you want
// and what it should say.

import type { PrTalkNote } from "../../../shared/types.ts";

const KEY = "agentglass.pr.talkNotify";

/**
 * How much of a conversation is allowed to interrupt you.
 *
 *   everything  a comment and a review both. What was asked for.
 *   reviews     only a review coming back — the verdict, whatever it is.
 *   off         nothing. The badges on the board stay either way; they are the
 *               quiet half of this feature and nobody has to be told about them.
 */
export type TalkNotify = "everything" | "reviews" | "off";

/** Everything, because that is what was asked for: a comment from a person, and
 *  a review the moment it is submitted. Somebody drowning in a busy repository
 *  narrows it to reviews once. */
export const TALK_NOTIFY_DEFAULT: TalkNotify = "everything";

export function talkNotify(): TalkNotify {
  try {
    const raw = localStorage.getItem(KEY);
    // The raw string, not a cast: an absent setting and a stored "off" both read
    // as falsy, which would make the default unreachable the moment anybody
    // turned it off and back on.
    if (raw === "everything" || raw === "reviews" || raw === "off") return raw;
    return TALK_NOTIFY_DEFAULT;
  } catch { return TALK_NOTIFY_DEFAULT; }
}

export function setTalkNotify(m: TalkNotify): void {
  try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
}

/** Whether this one reaches the bell. */
export function talkShouldNotify(n: Pick<PrTalkNote, "kind">, mode: TalkNotify = talkNotify()): boolean {
  if (mode === "off") return false;
  if (mode === "reviews") return n.kind === "review";
  return true;
}

/**
 * What happened, in the words a person would use.
 *
 * The verdict is named rather than implied. "priya reviewed #669" is true
 * of an approval and of a block, and those are opposite instructions — one is
 * "you can land it" and the other is "you are up".
 *
 * A `COMMENTED` review carrying line comments is reported as those comments,
 * because that is what it is: GitHub records a review for every batch of them,
 * and "reviewed" over three line notes with no summary reads as a verdict
 * nobody gave.
 */
export function talkVerb(n: Pick<PrTalkNote, "kind" | "state" | "lines">): string {
  if (n.kind === "comment") return "commented";
  if (n.state === "APPROVED") return "approved it";
  if (n.state === "CHANGES_REQUESTED") return "requested changes";
  if (n.state === "DISMISSED") return "dismissed a review";
  const lines = n.lines ?? 0;
  if (lines > 0) return lines === 1 ? "left a line comment" : `left ${lines} line comments`;
  return "reviewed it";
}

/** The bell's one line. Shaped like the CI note's — `repo#number — what` — so a
 *  list of notes about pull requests reads down. */
export function talkSummary(n: PrTalkNote): string {
  return `${n.repo}#${n.number} — ${n.who} ${talkVerb(n)}`;
}

/** Underneath: what the pull request is, and how much else came with it. */
export function talkBody(n: PrTalkNote): string {
  const more = n.more ?? 0;
  return more > 0
    ? `${n.title}\n+${more} more ${more === 1 ? "remark" : "remarks"} in the same conversation`
    : n.title;
}

/**
 * Changes requested is the only one of these that is a blockage.
 *
 * Everything else is news — an approval unblocks you, a comment is somebody
 * talking. A blockage takes the screen, which on this machine is the difference
 * between finding out now and finding out tomorrow morning.
 */
export function talkUrgency(n: Pick<PrTalkNote, "state">): 1 | 2 {
  return n.state === "CHANGES_REQUESTED" ? 2 : 1;
}
