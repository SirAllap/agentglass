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
export { talkVerb, talkSummary, talkBody, talkUrgency } from "../../../shared/talkWords.ts";

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
