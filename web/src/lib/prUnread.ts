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
// The two counts agree where the list can afford it: a bare "commented" review
// is not counted, and a review carrying a `lines` count counts each line. The
// list no longer asks for that count (see SEL_TALK in server/src/prs.ts: it was
// 15 of the 17 points the checks query cost), so on a card a batch of line
// comments is one remark where the conversation marks each line. The card
// still lights; its number can be lower than the panel's.


import type { PrSummary } from "../../../shared/types.ts";
import { unreadOf as unreadWith, type Unread } from "../../../shared/prUnread.ts";
import { readSeen } from "./prNew.ts";

export { bootstrapMark, unreadTitle, weightOf, type Unread } from "../../../shared/prUnread.ts";

/** What is unread on this row, or null for "nothing to say". The rules live in
 *  shared/prUnread.ts, where the phone counts with them too. */
export function unreadOf(
  pr: Pick<PrSummary, "number" | "talk">,
  repoKey: string | undefined,
  seen: Record<string, number> = readSeen(),
): Unread | null {
  return unreadWith(pr, repoKey, seen);
}
