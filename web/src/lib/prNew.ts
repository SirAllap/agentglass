// What has been said since you last looked, and where it is hiding.
//
// The measured problem, from a real review: a reply left nine minutes ago sat
// three comments deep inside a thread opened two days earlier, and finding it
// took several minutes of scrolling a conversation that gave no sign it had
// moved. Two causes, and only one of them is GitHub's.
//
// Ours is the ordering. A thread entered the timeline at the timestamp of its
// FIRST comment, so a live argument on an old thread was filed under the day it
// started — invisible to a "newest first" sort, because to the sort that thread
// really was two days old.
//
// GitHub's is that a conversation has no notion of "since you last looked". The
// unread state it keeps is per notification, not per pull request, and it is
// gone the moment you glance at the page from anywhere else.
//
// Everything here is pure and takes the detail the panel already loaded. No
// request is made from here: the one piece of state is a timestamp per pull
// request in this browser, and it is read from this browser. "Since *I* last
// looked" means on any of my machines, though, so each write is also handed
// to marksSync.ts, which shares it through the server and brings the other
// devices' marks back in through `applyServerSeen`.

import type { MarkOp, PrDetail, PrThread } from "../../../shared/types.ts";
import { reviewSpeaks } from "../../../shared/prConversation.ts";
import { at, bootstrapSince, newSince, prSeenKey, type NewAtom } from "../../../shared/prUnread.ts";
export { at, bootstrapSince, newSince, prSeenKey, type NewAtom };

/**
 * Where the last-looked-at timestamps live. One object, keyed by pull request
 * — see `prSeenKey`.
 *
 * NOT `agentglass.pr.seen`: that key is already taken, by the map of which
 * FILES you have ticked off in a diff. Two different questions, one word, and
 * the same storage key would have had each feature quietly deleting the
 * other's answer.
 */
export const SEEN_KEY = "agentglass.pr.lastlooked";

/**
 * How many pull requests we remember having looked at.
 *
 * Unbounded, this grows by one entry for every pull request ever opened and
 * never shrinks — on a busy repository that is thousands of keys in
 * localStorage, which has a hard quota and no eviction of its own. The oldest
 * visits are also the least useful: a pull request you have not opened in
 * months will read as "all new" whether we kept the mark or not.
 */
export const SEEN_MAX = 400;


/**
 * Marks written by a build that wrote them wrong are thrown away, once.
 *
 * A build shipped with a `visibilitychange` writer in it — the theory being
 * that closing the app is another way of leaving a pull request. It is not, and
 * the first thing it did was advance the mark on every pull request that was
 * open when the app was restarted, burying the very replies this feature exists
 * to surface. There is no way to tell a mark written that way from an honest
 * one, so all of them go.
 *
 * The cost of being wrong here is one visit's worth of "since your last
 * comment", which is the state a pull request has before its first visit
 * anyway. The cost of leaving them is somebody staring at a conversation that
 * says nothing happened when two people replied to them.
 *
 * Bump `SEEN_EPOCH` if that ever happens again. Nothing else should. And the
 * bump alone no longer does it: marksSync.ts shares these marks through the
 * server, and the next full GET brings the bad ones straight back. The `pr`
 * rows in the server's read_marks table have to be dropped as well, by hand —
 * nothing sends the epoch to the server yet. A known ceiling, not an oversight.
 */
export const SEEN_EPOCH = 2;
const EPOCH_KEY = `${SEEN_KEY}.epoch`;

export function migrateSeen(): void {
  try {
    if (Number(localStorage.getItem(EPOCH_KEY)) === SEEN_EPOCH) return;
    localStorage.removeItem(SEEN_KEY);
    localStorage.setItem(EPOCH_KEY, String(SEEN_EPOCH));
  } catch { /* private mode — nothing was stored to migrate */ }
}

/**
 * Anything drawing a badge from these marks.
 *
 * The board reads the whole map — one entry per pull request — and it is not
 * React state, so nothing re-renders when a mark moves. Without this, pressing
 * "Mark read" on a conversation and going back to the board leaves the badge up
 * on the very thing you just read, until something else happens to redraw it.
 */
const seenWatchers = new Set<() => void>();

export function onSeenChange(fn: () => void): () => void {
  seenWatchers.add(fn);
  return () => { seenWatchers.delete(fn); };
}

function announceSeen(): void {
  // A copy, because a listener is allowed to unsubscribe itself while being told.
  for (const fn of [...seenWatchers]) { try { fn(); } catch { /* a badge must not break a write */ } }
}

/** Where a local write goes after it is stored: marksSync, when it is running.
 *  Marks arriving FROM the server never come through here, or every device
 *  would send each mark straight back. */
let seenSink: ((op: MarkOp) => void) | null = null;
export function setSeenSink(fn: ((op: MarkOp) => void) | null): void { seenSink = fn; }

/** Persist the map, keeping the newest `SEEN_MAX`. */
function storeSeen(all: Record<string, number>): void {
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) {
    // Oldest visit first, and drop from that end.
    keys.sort((a, b) => (all[a] ?? 0) - (all[b] ?? 0));
    for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete all[k];
  }
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

export function readSeen(): Record<string, number> {
  // Here rather than wired into the panel, so there is no ordering to get
  // wrong: nothing can read the map before the migration has had its say.
  migrateSeen();
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Write down that this pull request has been read up to `at`.
 *
 * Never moves a mark BACKWARDS. Two windows on the same pull request, or a
 * stale tab writing after a fresh one, would otherwise resurrect comments the
 * reader has already dealt with — and an unread badge that comes back on its
 * own is worse than no badge, because it stops meaning anything.
 */
export function writeSeen(key: string, at: number): Record<string, number> {
  const all = readSeen();
  if ((all[key] ?? 0) >= at) return all;
  all[key] = at;
  storeSeen(all);
  announceSeen();
  seenSink?.({ kind: "pr", key, seenAt: at });
  return all;
}

/**
 * Forget having looked at this one, so its last mark stops applying.
 *
 * `writeSeen` refuses to move a mark backwards, which is right for the writes
 * that happen behind the reader's back and wrong for a reader who says "no, I
 * had not read those". This is the only way back, and it is deliberately its
 * own function rather than a flag on the other one.
 */
export function clearSeen(key: string): Record<string, number> {
  const all = readSeen();
  if (!(key in all)) return all;
  delete all[key];
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  announceSeen();
  seenSink?.({ kind: "pr", key, clear: true });
  return all;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Marks another device wrote, as the server holds them: the same two rules as
 * `writeSeen` and `clearSeen` — forward only, and 0 is an explicit "unread" —
 * applied in one pass and one write, and never handed to the sink.
 */
export function applyServerSeen(rows: { key: string; seenAt: number }[]): void {
  const all = readSeen();
  let moved = false;
  for (const r of rows) {
    // The map is a plain object: "__proto__" would reach its prototype, and
    // "toString" is `in` every object. The server refuses both shapes; this
    // does not rely on it.
    if (UNSAFE_KEYS.has(r.key)) continue;
    if (r.seenAt > 0) {
      if ((Object.hasOwn(all, r.key) ? all[r.key]! : 0) < r.seenAt) { all[r.key] = r.seenAt; moved = true; }
    } else if (Object.hasOwn(all, r.key)) { delete all[r.key]; moved = true; }
  }
  if (!moved) return;
  storeSeen(all);
  announceSeen();
}

/**
 * "Mark all read": advance every one of these pull requests to `at` in one
 * pass, the way pressing the chip's own button does it.
 *
 * The loop, not a new rule — each key still goes through `writeSeen`, so a
 * pull request this browser had already read past `at` keeps its own later
 * mark rather than being dragged backwards, and calling this twice with the
 * same `at` is a no-op the second time for exactly that reason. `numbers` is
 * meant to be whatever the unread chip counted; this does not decide who is
 * unread, only writes the mark for whoever is handed in.
 */
export function markAllSeen(numbers: number[], repo: string | undefined, at: number): Record<string, number> {
  let all = readSeen();
  for (const n of numbers) all = writeSeen(prSeenKey(repo, n), at);
  return all;
}


/**
 * When a thread was last spoken in.
 *
 * The whole fix for the ordering rests on this one line: a thread has two
 * timestamps, when it was opened and when it was last answered, and the
 * timeline was using the first for both jobs.
 */
export function threadLastAt(t: Pick<PrThread, "comments">): number {
  let last = 0;
  for (const c of t.comments) last = Math.max(last, at(c.createdAt));
  return last;
}

/** When it was opened — the timestamp the timeline used to sort by. */
export function threadFirstAt(t: Pick<PrThread, "comments">): number {
  return at(t.comments[0]?.createdAt);
}

/**
 * A thread that has moved on since the review it was submitted with.
 *
 * Such a thread is drawn at the top level of the timeline instead of nested
 * under that review, because the nesting is what buries it: the review is dated
 * two days ago and everything under it inherits that position on the page. It
 * keeps a chip naming the review it came from, so the grouping is still legible
 * — that grouping IS the meaning of a "requested changes", and dropping it to
 * fix an ordering bug would trade one loss for another.
 */
export function threadMovedOn(t: Pick<PrThread, "comments">, reviewAt: string | undefined): boolean {
  const r = at(reviewAt);
  return r > 0 && threadLastAt(t) > r;
}

// The rule lives in shared/ so the phone counts a review the way this panel does.
export { reviewSpeaks };

/** The id an atom's element carries, so the bar can scroll to it. */
export const anchorId = (key: string): string => `agx-new-${key}`;


/** The atoms, by anchor key, for the O(1) "is this one new" the rendering asks
 *  once per comment. */
export function newKeys(atoms: NewAtom[]): Set<string> {
  return new Set(atoms.map((a) => a.key));
}


/**
 * Which replies to hide when a thread is long.
 *
 * A thread is read from its ends: the remark that started it and the last thing
 * anybody said. The middle is history — and on the thread that prompted all of
 * this, the middle was three long comments sitting between the reader and the
 * reply they were looking for.
 *
 * Anything new is always kept, whatever its position: hiding the thing this
 * whole feature exists to surface would be a fine joke and a bad tool.
 */
export function foldedIdx(total: number, keep: Set<number>, min = 4): Set<number> {
  const hidden = new Set<number>();
  if (total < min) return hidden;
  for (let i = 1; i < total - 1; i++) if (!keep.has(i)) hidden.add(i);
  // Folding a single comment saves one line and costs a click. Not worth it.
  return hidden.size > 1 ? hidden : new Set<number>();
}

/** "3 new" / "1 new" — said in full because "3n" is not a word. */
export const newLabel = (n: number): string => `${n} new`;
