// The one mark on a pull request row that is about YOU rather than about the
// pull request. On the board and on the table, because they are the same
// question asked of two surfaces, and a badge that only exists on one of them is
// a surface people learn not to trust.
import { unreadTitle, type Unread } from "../lib/prUnread.ts";

/**
 * What has been said on this one since you last looked.
 *
 * The one thing on a card that is about YOU rather than about the pull request,
 * and the reason it is here at all: the conversation has answered "what is new"
 * for a while, but only once you had opened the thing — and which of these
 * twelve to open is the question the board is for. Amber, because it is the same
 * "somebody is waiting on you" the conversation marks with, and drawn as a
 * bubble with a number so it cannot be read as a check state.
 *
 * Never a bot: the count comes from `talk`, which has none in it (see mapTalk).
 */
export function UnreadBadge({ u }: { u: Unread }) {
  return (
    <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] tabular-nums"
      title={unreadTitle(u)}
      style={{
        color: "var(--warning)",
        border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
        background: "color-mix(in srgb, var(--warning) 14%, transparent)",
      }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      {u.count}
    </span>
  );
}
