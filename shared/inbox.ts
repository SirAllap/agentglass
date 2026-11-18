/*
 * What is waiting on you, ranked once.
 *
 * The desk already answers this question in `web/src/lib/attention.ts`, from
 * the live stream plus the alert panel's poll. The phone has no stream, so the
 * inputs differ; the three level words do not, because a person who has learnt
 * what "blocking" means at the desk should not have to learn a second ladder in
 * their hand.
 *
 * ── the ceiling ───────────────────────────────────────────────────────────
 * Two implementations, and this one is the phone's. Its ceiling is the badge:
 * the bell counts ONLY what this module ranks, and every other number on the
 * phone's bar went away in the same change so one number has one home (see
 * mobile/src/nav/TabBar.tsx).
 *
 * Pure, with no React and no route: the ranking is the thing worth locking
 * down, and mobile/test/inbox.test.ts holds it as data. The screens that build
 * the rows from six answers live in mobile/src/model/inbox.ts.
 */

/** The ladder, worst first: `blocking` is something stopped until you answer,
 *  `error` is something that went wrong or was left, `warn` is worth knowing. */
export type InboxLevel = "blocking" | "error" | "warn";

export const LEVEL_RANK: Record<InboxLevel, number> = { blocking: 0, error: 1, warn: 2 };

/** Which question produced the row. Also the word the row's chip carries. */
export type InboxSource = "gate" | "settings" | "review" | "agent" | "plan" | "watch";

/**
 * Where a row goes, in data. A row is one line and one tap: the action says
 * what the tap opens (or which answer it posts) without the screen deciding
 * from a sentence.
 *
 * `watch` carries the queue position as well as the pull request: tapping the
 * row opens the PR (a read) and acknowledging the fire is the other half, so
 * the row cannot do the first and forget the second.
 */
export type InboxAction =
  | { kind: "gate"; id: string }
  | { kind: "settings"; id: string }
  | { kind: "review"; root: string; repo: string; number: number }
  | { kind: "agent" }
  | { kind: "plan"; id: string }
  | { kind: "watch"; seq: number; repo: string; number: number; root?: string };

export interface InboxItem {
  /** Stable across reads, so a list does not re-key rows that did not move. */
  id: string;
  level: InboxLevel;
  source: InboxSource;
  /** The one line, in the words the row draws. */
  text: string;
  /** The second line: where it is, who asked, how long. */
  detail: string;
  /** When it started waiting, ms — the tie inside a level. */
  at: number;
  /**
   * Whether this pairing's scope lets the phone act. A row it may not act on
   * is still drawn: the thing IS waiting, and hiding it because this phone
   * cannot answer would be a phone that lies about the machine. The row says
   * why in one line instead of drawing a dead control.
   */
  canAct: boolean;
  action: InboxAction;
}

/**
 * Worst first, then the one that has waited longest.
 *
 * Oldest first inside a level, unlike the desk's newest-first: every row here
 * is a thing that WAITS (a held command, a settings request, a review asked of
 * you), and the one that has waited longest is the one to answer. The gates'
 * own list already sorts this way (`gatesInOrder`), and a phone that ordered
 * the same gates differently on two screens would be a second answer.
 */
export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort(
    (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.at - b.at || a.id.localeCompare(b.id),
  );
}

/** The one number: the rows the bell counts are exactly the rows the list
 *  draws, so "4 waiting" and four rows can never disagree. */
export const inboxCount = (items: readonly InboxItem[]): number => items.length;
