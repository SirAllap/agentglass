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
import type { HandoffConfig, HandoffUnassign, ListStatus } from "../../../shared/providers.ts";
import { planOf } from "../../../shared/stepBlocks.ts";
import type { ReviewRecipeContext } from "../../../shared/types.ts";
import { expandRecipe } from "../../../shared/recipeText.ts";
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
  setup: { connected: boolean; prefix?: string; noCustomIds?: boolean } | null,
): { label: string; query: string } | null {
  if (!setup?.connected) return null;
  const ref = cardRef(pr);
  if (!ref) return null;
  if (ref.from === "url") return { label: ref.label, query: ref.query };
  if (!looksLikeOurs(ref, setup?.prefix, false, setup?.noCustomIds)) return null;
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
  /** The list it lives in, for reading who can be put on it. */
  listId?: string;
  /** Who is on the card now: what "Also assign" is decided against. */
  people?: { id?: number | null; me?: boolean; name?: string }[];
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

/**
 * The list's own name for the QA hand-off status, found by matching rather
 * than assumed — one workspace spells it "Ready for QA", another "ready for
 * qa", a third "Testing", and the word is theirs, not this app's. Undefined
 * when the hand-off is off, when the list has none of the names, or when the
 * card is already sitting in the one it would move to: in each case there is
 * nothing for a "move" control to offer.
 *
 * `cfg` is the workspace's hand-off setting. Names are tried in the order they
 * were written and the first one the list HAS wins, compared without regard to
 * case; an empty list means the one name this app shipped with, unless the
 * step's move block is still waiting for a status (nothing is moved then).
 * A step with no move block moves nothing, so there is no status to find. Without a
 * `cfg` the answer is that shipped behaviour, which is what callers that have
 * not read the settings yet get.
 */
export function readyForQaStatus(statuses: ListStatus[], current: string, cfg?: HandoffConfig): string | undefined {
  if (cfg && !cfg.enabled) return undefined;
  /* Blocks say whether the step moves at all, and whether it names a status or is waiting for one. */
  const plan = cfg ? planOf("move", cfg) : null;
  if (plan && !plan.move) return undefined;
  const named = plan?.move?.names ?? [];
  const names = named.length ? named : plan && !plan.move!.fallback ? [] : ["ready for qa"];
  for (const name of names) {
    const hit = statuses.find((s) => eqStatus(s.status, name));
    if (hit) return eqStatus(hit.status, current) ? undefined : hit.status;
  }
  return undefined;
}

/**
 * The status the review menu offers to move the card to, or "" to leave it
 * where it is. Found by asking the list, never by assuming a word: one board's
 * "Code Review" is another's "In review" and a third's "PR up".
 *
 * `names` is the workspace's own spelling, tried in the order written, compared
 * without regard to case; the first one the list HAS wins. With none written,
 * the guess is any status with "review" in it. With some written and none
 * present the answer is to leave the card alone, not to guess past what the
 * workspace said. A status that closes the card is never the answer to "put it
 * in review", whatever it is called ("Reviewed" is done, not in review), and
 * neither is the one the card is already in.
 */
export function reviewStatus(statuses: ListStatus[], current: string, names: string[]): string {
  const open = statuses.filter((s) => s.type !== "done" && s.type !== "closed");
  let hit: ListStatus | undefined;
  if (names.length) {
    for (const n of names) { hit = open.find((s) => eqStatus(s.status, n)); if (hit) break; }
  } else hit = open.find((s) => /review/i.test(s.status));
  return hit && !eqStatus(hit.status, current) ? hit.status : "";
}

/**
 * What the merge dialog's card choice opens on: the first of the workspace's
 * names that the card's list has, unless the card is already there, else
 * `LEAVE_ALONE`. Offered, never imposed: the dialog still lets the person
 * change it, and leaving it writes nothing. Names are the workspace's own, so
 * a list without any of them preselects nothing rather than guessing a word.
 */
export function mergePreselect(statuses: ListStatus[], current: string, names: string[]): string {
  for (const n of names) {
    const hit = statuses.find((x) => eqStatus(x.status, n));
    if (hit) return eqStatus(hit.status, current) ? LEAVE_ALONE : hit.status;
  }
  return LEAVE_ALONE;
}

/**
 * Who the note is for: somebody else on the card. Falls back to nobody rather
 * than to the connected account, who is the one opening the pull request —
 * telling yourself your own branch is ready is the one message that is never
 * useful. With two others on the card the first is chosen; a picker is the
 * next thing after this and is not here.
 */
export function whoToTell<P extends { id?: number; name: string; me?: boolean }>(task: { people?: P[] } | null): P | null {
  return task?.people?.find((p) => !p.me) ?? null;
}

/** The note the card gets when the "Note on card" box opens, from the
 *  `note-on-card` wording in the prompt catalogue. `fallback` is the shipped
 *  wording, for the seconds before the catalogue arrives and for somebody who
 *  deleted the entry. `{who}` is the mention, so an empty one leaves no gap. */
export function cardNoteText(body: string | undefined, fallback: string, ctx: ReviewRecipeContext): string {
  return expandRecipe((body || "").trim() || fallback, ctx).trim();
}

/**
 * Who the hand-off takes off the card: nobody, only the connected account, or
 * everybody. The ids go in the same single write as the status.
 */
export function handoffRemovals(people: { id?: number | null; me?: boolean }[] | undefined, unassign: HandoffUnassign): number[] {
  if (unassign === "none") return [];
  return (people ?? [])
    .filter((p) => unassign === "all" || p.me === true)
    .map((p) => p.id)
    .filter((n): n is number => n != null);
}

/**
 * The one write the hand-off makes: the new status and, when the setting takes
 * anybody off, their ids. `none` sends no `rem` at all rather than an empty
 * one, so the request carries exactly what will change.
 */
export function handoffChanges(
  target: string,
  people: { id?: number | null; me?: boolean }[] | undefined,
  unassign: HandoffUnassign,
): { status: string; rem?: number[] } {
  const rem = handoffRemovals(people, unassign);
  return rem.length ? { status: target, rem } : { status: target };
}

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
export function mergeNote(
  merged: boolean,
  move: { asked: boolean; ok?: boolean; to?: string; error?: string; unauthorised?: boolean; extra?: string },
): string {
  if (!merged) return "Merge failed";
  if (!move.asked) return "Merged";
  if (move.ok) return `Merged · card moved to ${move.to}${move.extra ? ` · ${move.extra}` : ""}`;
  /*
   * A refused token is the one failure here that pressing the button again
   * cannot fix, and the sentence has to say so — otherwise "ClickUp refused
   * this token" reads as a hiccup and the next move is a retry that will be
   * refused in exactly the same way. Where to go instead is the actual news.
   */
  if (move.unauthorised) return "Merged — the card did not move: ClickUp refused this token. Reconnect it in Settings.";
  return `Merged — but the card did not move: ${move.error || "ClickUp refused"}`;
}
