/*
 * What it says when a person speaks on a pull request.
 *
 * Shared because the desk and the phone say the same thing about the same
 * event: this used to live only in web/src/lib/talkNotify.ts, which the phone
 * cannot import (it pulls in `localStorage`-backed preference code that does
 * not exist on a phone). Only the pure wording moved — the preference itself
 * (`talkNotify`/`setTalkNotify`/`talkShouldNotify`) stays in that file, because
 * "how much of this reaches you" is answered per-platform (localStorage on the
 * desk, expo-secure-store on the phone, see mobile/src/notifications/talkPref.ts),
 * not shared.
 */
import type { PrTalkNote } from "./types.ts";

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
