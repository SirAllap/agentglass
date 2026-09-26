/*
 * What "since I last looked" means on the phone, decided without a screen.
 *
 * The counting is shared/prUnread.ts, the browser's own, so a badge here and a
 * badge on the desk cannot disagree. This file is the phone's two extra
 * questions: how a mark the server sent changes what we hold, and which entries
 * of the conversation the divider and the "new" chips go on.
 */
import type { MarkRow, PrDetail } from "../../../shared/types.ts";
import { markKeyFits } from "../../../shared/marks.ts";
import type { ConvEntry } from "../../../shared/prConversation.ts";
import { commentAtomKey, newSince, reviewAtomKey } from "../../../shared/prUnread.ts";

export type Seen = Record<string, number>;

/**
 * The marks after these rows, or the very same object when none of them changed
 * anything — a store that hands out a fresh object for a replayed row repaints
 * every list on the phone for nothing.
 *
 * The server's row wins outright. It has already taken the newest of every
 * device's mark (max wins there), so taking it as-is is what makes a read on
 * the desk arrive here, and a zero — the desk's "mark unread" — is the one way
 * a mark goes backwards.
 */
export function applyMarkRows(seen: Seen, rows: MarkRow[]): Seen {
  let next: Seen | null = null;
  for (const r of rows) {
    if (r.kind !== "pr" || !markKeyFits("pr", r.key)) continue;
    const had = (next ?? seen)[r.key] ?? 0;
    const now = Math.max(0, r.seenAt);
    if (had === now) continue;
    next ??= { ...seen };
    if (now) next[r.key] = now; else delete next[r.key];
  }
  return next ?? seen;
}

export interface Newness {
  /** Entries with something new in them. A thread counts when a reply is new,
   *  though it is filed under the day it began. */
  keys: Set<string>;
  /** How many remarks are new, counted the way the desk counts them. */
  count: number;
  /** The entry the "new" divider goes above, or null. The first entry that
   *  itself came after the mark: the list is oldest first, so everything below
   *  it is new too. A reply in an old thread does not move it up — that would
   *  say the whole stretch between was unread. */
  dividerBefore: string | null;
}

/** Which entries of `entries` are new since `since`. 0 means never looked and
 *  says nothing, for the reason `newSince` gives. */
export function newness(entries: ConvEntry[], detail: PrDetail, since: number): Newness {
  const atoms = newSince(detail, since);
  const atomKeys = new Set(atoms.map((a) => a.key));
  const threads = new Set(atoms.flatMap((a) => (a.threadId ? [a.threadId] : [])));
  const keys = new Set<string>();
  let dividerBefore: string | null = null;
  for (const e of entries) {
    const isNew = e.kind === "comment" ? atomKeys.has(commentAtomKey(e.comment.id))
      : e.kind === "review" ? atomKeys.has(reviewAtomKey(e.review))
      : threads.has(e.thread.id);
    if (!isNew) continue;
    keys.add(e.key);
    // A thread is filed under its first remark, so one that began before the
    // mark and got a new reply is flagged but is not where the divider goes.
    if (dividerBefore === null && e.at > since) dividerBefore = e.key;
  }
  return { keys, count: atoms.length, dividerBefore };
}
