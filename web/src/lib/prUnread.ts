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
