// Whether a pull request conflicts with its base, shared by the board and the
// page you open from it.
//
// GitHub computes `mergeable` lazily: the list answers UNKNOWN for a pull
// request nobody has asked about lately, and a card that only badges
// CONFLICTING files it under "Green, ready to land" while its own page — which
// asks git for the conflicting files — says "Resolve 24 files". One fact, two
// answers.
//
// The truth is cheap to get from the server (a merge in git's object database,
// cached for 45 s by `conflictPreview`), so a card whose row is UNKNOWN asks
// for it, a few at a time and at most MAX_PER_MINUTE of them, and the page
// writes what it learns here too. `withConflict` then lays the answer over the
// row, so the badge, the lane and the Failing view all read the same thing.

import { api } from "./api.ts";
import type { PrSummary } from "../../../shared/types.ts";

/** At once. The preview is a merge on the server; the board is a glance. */
const AT_ONCE = 2;
/** A ceiling on a board of fifty UNKNOWN rows scrolled through. */
const MAX_PER_MINUTE = 20;
/** An answer is trusted for as long as the pull request's head is the same;
 *  this only bounds how long a "clean" is believed before it is asked again. */
const CLEAN_TTL_MS = 5 * 60_000;
/** One retry, after a failed ask, and then the TTL's pace. */
const RETRY_MS = 30_000;

type Entry = { at: number; conflicts: boolean | null; sha: string | null; failed: number };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; root: string; number: number; sha: string | null }[] = [];
const listeners = new Set<() => void>();
let running = 0;
let version = 0;
let windowStart = 0;
let askedInWindow = 0;

const keyOf = (root: string, number: number) => `${root}::${number}`;

function tell(): void {
  version++;
  for (const l of listeners) l();
}

export const onConflict = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const conflictVersion = (): number => version;

/** A preview that names files is a conflict; a stale one (the merge could not be
 *  redone) is no answer. Same rule as the page's `prConflicted`. */
export const conflictsFrom = (r: { ok: boolean; conflicts: string[]; stale?: boolean }): boolean | null =>
  r.ok && !r.stale ? r.conflicts.length > 0 : null;

function allowed(now: number): boolean {
  if (now - windowStart >= 60_000) { windowStart = now; askedInWindow = 0; }
  return askedInWindow < MAX_PER_MINUTE;
}

function pump(): void {
  while (running < AT_ONCE && waiting.length && allowed(Date.now())) {
    const job = waiting.shift()!;
    askedInWindow++;
    running++;
    inflight.add(job.key);
    api.prConflictFiles(job.root, job.number)
      .then((r) => { learn(job.root, job.number, conflictsFrom(r), job.sha); })
      .catch(() => { learn(job.root, job.number, null, job.sha); })
      .finally(() => { running--; inflight.delete(job.key); pump(); });
  }
}

/**
 * Write what somebody found out. The page calls this with the files it listed;
 * the queue calls it with the preview's answer. `null` is "could not tell" and
 * never overwrites an answer already held.
 */
export function learn(root: string, number: number, conflicts: boolean | null, sha: string | null = null): void {
  if (!root || !number) return;
  const key = keyOf(root, number);
  const was = seen.get(key);
  if (conflicts === null) {
    if (was && was.conflicts !== null) return;
    seen.set(key, { at: Date.now(), conflicts: null, sha, failed: (was?.failed ?? 0) + 1 });
  } else {
    if (was && was.conflicts === conflicts && was.sha === sha) { seen.set(key, { ...was, at: Date.now() }); return; }
    seen.set(key, { at: Date.now(), conflicts, sha, failed: 0 });
  }
  tell();
}

const fresh = (e: Entry, sha: string | null | undefined, now: number): boolean => {
  if (e.sha && sha && e.sha !== sha) return false; // pushed since: that answer is about another commit
  if (e.conflicts === true) return true;           // holds until the head moves
  if (e.conflicts === false) return now - e.at < CLEAN_TTL_MS;
  return now - e.at < (e.failed <= 1 ? RETRY_MS : CLEAN_TTL_MS);
};

/**
 * Ask, if nobody has lately. Called by whoever draws a card whose row says
 * UNKNOWN: it is the thing that knows the card is on screen. Never while the
 * window is in the background.
 */
export function askConflict(root: string, row: Pick<PrSummary, "number" | "mergeable" | "headSha">): void {
  if (!root || !row.number || row.mergeable !== "UNKNOWN") return;
  if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) return;
  const key = keyOf(root, row.number);
  const hit = seen.get(key);
  if (hit && fresh(hit, row.headSha, Date.now())) return;
  if (inflight.has(key) || waiting.some((w) => w.key === key)) return;
  waiting.push({ key, root, number: row.number, sha: row.headSha ?? null });
  pump();
}

/** Still being worked out: the row says UNKNOWN and no answer is held. */
export function checkingConflict(root: string, row: Pick<PrSummary, "number" | "mergeable" | "headSha">): boolean {
  if (!root || row.mergeable !== "UNKNOWN") return false;
  const hit = seen.get(keyOf(root, row.number));
  return !hit || !fresh(hit, row.headSha, Date.now()) || hit.conflicts === null;
}

/**
 * The row with a conflict the page or the preview found written over GitHub's
 * UNKNOWN. Only that direction: a clean preview does not call a pull request
 * mergeable (checks and reviews are GitHub's), it just stops it saying
 * "checking". Same object back when nothing changes.
 */
export function withConflict<T extends Pick<PrSummary, "number" | "mergeable" | "headSha">>(root: string, p: T): T {
  if (!root || p.mergeable !== "UNKNOWN") return p;
  const hit = seen.get(keyOf(root, p.number));
  if (!hit || hit.conflicts !== true || !fresh(hit, p.headSha, Date.now())) return p;
  return { ...p, mergeable: "CONFLICTING" };
}

/** For a test, or a repository that has just changed under the panel. */
export function forgetConflicts(): void {
  seen.clear();
  waiting.length = 0;
  windowStart = 0;
  askedInWindow = 0;
}
