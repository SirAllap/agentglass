/*
 * Moving the card the pull request came from, at the moment it lands.
 *
 * The gap this closes is a habit, not a feature: merge in the panel, then go
 * to ClickUp and drag the card out of Code Review by hand — and sometimes not,
 * because nothing on the merge asked. The card is already known here (the chip
 * next to the title is `cardRef`), and the board it lives on already publishes
 * what its columns are called, so the one thing missing was being asked.
 *
 * The rules live here rather than in the dialog because they are the part with
 * consequences — a wrong pick writes to somebody's real board — and because a
 * status is not a value you can reason about from its name. Status NAMES are
 * per-list: one board's "Code Review" is another's "In review" and a third's
 * "PR up". Nothing here may branch on the words.
 */
import type { ListStatus } from "../../../shared/providers.ts";
import { cardRef, looksLikeOurs } from "./cardRef.ts";

/**
 * The card to offer moving, or nothing.
 *
 * Stricter than the chip that links to it, and deliberately: the chip opens
 * something, this WRITES to somebody's board. A reference read out of a branch
 * name is a convention other trackers share — `ABC-12-thing` is what a Jira
 * shop's branches look like too — so it is only offered when something
 * corroborates it. A ClickUp address in the body is proof by itself. A prefix
 * we have actually read from this workspace's own cards is the other proof.
 * With neither, the honest answer is to say nothing rather than open a merge
 * form offering to move a card that does not exist.
 *
 * All of which is about the CARD, and there is a question before it: can this
 * machine write to ClickUp at all. Without a token it cannot, whatever the
 * evidence — so a pull request carrying a clickup.com address, which is proof
 * of a card and no proof of a connection, used to open a merge form that spun
 * on "Looking up ORBIT-1042 on ClickUp…" before admitting there was no ClickUp
 * to look in. That is a real body: a fork of a team that uses ClickUp, or a
 * contributor who pasted a link. Asked first, so the rest is never reached.
 */
export function mergeCardRef(
  pr: { headRefName?: string; title?: string; body?: string },
  setup: { connected: boolean; prefix?: string } | null,
): { label: string; query: string } | null {
  if (!setup?.connected) return null;
  const ref = cardRef(pr);
  if (!ref) return null;
  if (ref.from === "url") return { label: ref.label, query: ref.query };
  if (!setup?.prefix || !looksLikeOurs(ref, setup.prefix)) return null;
  return { label: ref.label, query: ref.query };
}

/** Where a card is, and where it could go. */
export type CardMove = {
  /** ClickUp's own task id — what the write is addressed to. */
  id: string;
  /** What the chip says: the human id when the workspace has them on. */
  label: string;
  title: string;
  /** As the workspace spells it today. */
  status: string;
  /** The colour the workspace gave that status. Boards are read by colour
   *  before they are read by word, and a status torn out of its colour is a
   *  status somebody has to stop and parse. */
  statusColor?: string;
  /** The precondition for the write: somebody else moving the card between
   *  this read and the merge should be a conflict, not a silent overwrite. */
  updated: number;
  statuses: ListStatus[];
};

/**
 * The statuses to MOVE to, in the board's own order — never the one the card is
 * already in.
 *
 * That one used to be in the list, and selected, so that doing nothing was a
 * no-op. It was read exactly the wrong way: "Move ORBIT-1042 to Code Review"
 * with Code Review already on it looks like a promise to set the status it
 * already has. Leaving it alone is now a named option of its own (see
 * LEAVE_ALONE) rather than a value that happens to be inert, because a default
 * has to SAY what it does.
 */
export function statusOptions(statuses: ListStatus[], current: string): ListStatus[] {
  return [...statuses]
    .filter((s) => !eqStatus(s.status, current))
    .sort((a, b) => a.orderindex - b.orderindex);
}

/** The value of "do not touch the board", and the option the dialog opens on.
 *  Empty, so it can never collide with a status a workspace has actually
 *  named. */
export const LEAVE_ALONE = "";

/**
 * Whether confirming would move anything.
 *
 * The dialog opens on LEAVE_ALONE, so the default writes nothing at all — which
 * is what makes it safe to offer on every merge. The case-insensitive compare
 * stays because ClickUp returns status names in the list's own case, and a
 * round-tripped status must not post a pointless write.
 */
export function movesCard(current: string, pick: string): boolean {
  return !!pick.trim() && !eqStatus(current, pick);
}

const eqStatus = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The colour a board gave a status, or nothing — never an invented one. A
 *  made-up colour standing beside real ones reads as a real one. */
export function statusColor(statuses: ListStatus[], status: string): string | undefined {
  return statuses.find((s) => eqStatus(s.status, status))?.color || undefined;
}

/**
 * What the merge should say afterwards, given how the two halves went.
 *
 * The merge and the card move are separate writes to separate systems, and the
 * second one failing must never read as the first one having failed — the pull
 * request IS merged, and telling somebody otherwise sends them to un-merge
 * something. So the wording always leads with the merge.
 */
export function mergeNote(merged: boolean, move: { asked: boolean; ok?: boolean; to?: string; error?: string }): string {
  if (!merged) return "Merge failed";
  if (!move.asked) return "Merged";
  if (move.ok) return `Merged · card moved to ${move.to}`;
  return `Merged — but the card did not move: ${move.error || "ClickUp refused"}`;
}
