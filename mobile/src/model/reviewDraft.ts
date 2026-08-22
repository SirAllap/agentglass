/*
 * A review being written, before any of it has been sent.
 *
 * ── why it is held at all ────────────────────────────────────────────────
 * Because a review is a verdict AND its comments, and `/prs/review-with`
 * takes both in one call. Posting each remark as it is typed produces a thread
 * per remark and, when the phone loses signal halfway — which on a phone is
 * Tuesday — leaves three observations with no conclusion on somebody's pull
 * request. That reads as an opinion nobody finished, and there is no undo for
 * it that is not another comment.
 *
 * ── why it is a module and not component state ───────────────────────────
 * Two screens share it. Comments are written on the diff and sent from the
 * pull request, and the diff is a separate route — so state inside either one
 * is state the other cannot see, and state inside a shared parent does not
 * exist here because the router is the parent.
 *
 * It also has to survive leaving the diff and coming back, which is the
 * ordinary way of reading eleven files.
 *
 * ── and why it is NOT persisted ──────────────────────────────────────────
 * Deliberately in memory. A draft that outlived the app would come back days
 * later against a head commit that has moved, and line 148 is not the same
 * line it was — so the comment would be right about code nobody can find. The
 * cost is losing a half-written review to a swipe-up, which is recoverable by
 * writing it again; the other failure is not.
 */

/** One remark, anchored to a line of the file as it is NOW. `commentableLine`
 *  in diffLines.ts is what decides a row may carry one — a deleted line has no
 *  such number, so it cannot. */
export interface LineNote {
  path: string;
  line: number;
  body: string;
}

/** Keyed by checkout and number, because two pull requests can be open at
 *  once and a comment written on one must never travel to the other. */
const drafts = new Map<string, LineNote[]>();

/** What is queued for this pull request. Always an array — "none yet" and
 *  "none left" are the same thing to every caller. */
export function draft(key: string): LineNote[] {
  return drafts.get(key) ?? [];
}

export function draftCount(key: string): number {
  return drafts.get(key)?.length ?? 0;
}

/**
 * Change the draft, and get back what it became.
 *
 * A function rather than a setter because every caller so far is a
 * read-modify-write — add this note, drop that one — and handing the current
 * value in is what stops two of them racing to overwrite each other with a
 * stale copy.
 */
export function takeDraft(key: string, change: (was: LineNote[]) => LineNote[]): LineNote[] {
  const next = change(draft(key));
  if (next.length) drafts.set(key, next);
  else drafts.delete(key);
  return next;
}

/** Everything queued is gone. Called when a review is SENT, and only then:
 *  clearing on a failure would throw away what somebody typed because a
 *  network dropped. */
export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** For tests, which must not inherit a draft from the one before. */
export function clearAllDrafts(): void {
  drafts.clear();
}

/**
 * The comments as `/prs/review-with` wants them.
 *
 * Its own function so the screen and its test agree on the shape, and so the
 * one thing the wire needs that the draft does not carry — the side — is
 * stated once. RIGHT always: these are anchored to the file as it is now,
 * which is the only side `commentableLine` ever produces a number for.
 */
export function forWire(notes: LineNote[]): { path: string; line: number; side: "RIGHT"; body: string }[] {
  return notes.map((n) => ({ path: n.path, line: n.line, side: "RIGHT", body: n.body }));
}
