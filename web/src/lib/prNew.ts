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
// request is made and nothing is stored on the server: the one piece of state
// is a timestamp per pull request in this browser, which is enough because the
// question is "since *I* last looked", and only this browser knows that.

import type { PrDetail, PrThread } from "../../../shared/types.ts";

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

/** `owner/repo#123`. The repo is part of it because pull request numbers are
 *  per repository and a bare number collides across every project you have. */
export function prSeenKey(repo: string | undefined, number: number): string {
  return `${repo || "?"}#${number}`;
}

export function readSeen(): Record<string, number> {
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
  const keys = Object.keys(all);
  if (keys.length > SEEN_MAX) {
    // Oldest visit first, and drop from that end.
    keys.sort((a, b) => (all[a] ?? 0) - (all[b] ?? 0));
    for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete all[k];
  }
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch { /* private mode */ }
  return all;
}

/** Epoch milliseconds, or 0 for anything unparseable — an unreadable date must
 *  not read as "just now" and put a NEW badge on a two-year-old comment. */
export function at(iso: string | undefined | null): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
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

/** One thing that has been said since your last visit, in the order it was
 *  said. `key` is the anchor the jump scrolls to. */
export interface NewAtom {
  key: string;
  at: number;
  author: string;
  /** Human-readable place, for the bar: a path or "the conversation". */
  where: string;
  kind: "thread" | "comment" | "review";
  /** The thread it belongs to, when it is a reply. */
  threadId?: string;
}

/** The id an atom's element carries, so the bar can scroll to it. */
export const anchorId = (key: string): string => `agx-new-${key}`;

/**
 * Everything said since `since`, oldest first.
 *
 * `since` of 0 means "never looked at this one" and returns nothing on purpose.
 * The first time you open a pull request every comment on it is, technically,
 * new to you — and a bar announcing "41 new" on a pull request you have simply
 * never seen is noise dressed as news. The visit is recorded and the next
 * arrival is the first thing marked.
 *
 * Your own remarks never count. A reply you just posted is not something to go
 * and find, and counting it means the badge lights up because you spoke.
 */
export function newSince(d: PrDetail | null | undefined, since: number): NewAtom[] {
  if (!d || !since) return [];
  const out: NewAtom[] = [];
  const mine = (viewerDidAuthor?: boolean) => viewerDidAuthor === true;

  for (const t of d.threads ?? []) {
    for (const c of t.comments) {
      const when = at(c.createdAt);
      if (when <= since || mine(c.viewerDidAuthor)) continue;
      out.push({
        key: `${t.id}:${c.id}`, at: when, author: c.author, kind: "thread",
        where: t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "a line comment",
        threadId: t.id,
      });
    }
  }
  for (const c of d.comments ?? []) {
    const when = at(c.createdAt);
    if (when <= since || mine(c.viewerDidAuthor)) continue;
    out.push({ key: `c${c.id}`, at: when, author: c.author, kind: "comment", where: "the conversation" });
  }
  for (const r of d.reviews ?? []) {
    const when = at(r.submittedAt);
    if (when <= since || mine(r.viewerDidAuthor)) continue;
    out.push({ key: `r${r.author}-${r.submittedAt}`, at: when, author: r.author, kind: "review", where: "a review" });
  }

  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

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
