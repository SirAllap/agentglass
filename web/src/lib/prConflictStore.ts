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

/** One at a time: the preview is a merge on the server and the board is a glance. */
const AT_ONCE = 1;
/** A ceiling on a board scrolled through quickly. */
const MAX_PER_MINUTE = 6;
/** A "could not tell" is asked once more, no sooner than this, and then left. */
const RETRY_MS = 60_000;
/** Answers outlive the panel: reopening it must not ask again. */
const STORE_KEY = "agx.prConflict.v1";
const STORE_MAX = 400;

type Entry = { at: number; conflicts: boolean | null; sha: string | null; failed: number };

const seen = new Map<string, Entry>();
let loaded = false;
const load = (): void => {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORE_KEY) : null;
    if (raw) for (const [k, e] of JSON.parse(raw) as [string, Entry][]) if (!seen.has(k)) seen.set(k, e);
  } catch { /* private window, blocked storage: the memory copy still works */ }
};
const save = (): void => {
  try {
    if (typeof localStorage === "undefined") return;
    // Only answers: a failure is worth remembering for a minute, not across a restart.
    const rows = [...seen].filter(([, e]) => e.conflicts !== null).slice(-STORE_MAX);
    localStorage.setItem(STORE_KEY, JSON.stringify(rows));
  } catch { /* same */ }
};
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
  load();
  const key = keyOf(root, number);
  const was = seen.get(key);
  if (conflicts === null) {
    if (was && was.conflicts !== null) return;
    seen.set(key, { at: Date.now(), conflicts: null, sha, failed: (was?.failed ?? 0) + 1 });
  } else {
    if (was && was.conflicts === conflicts && was.sha === sha) { seen.set(key, { ...was, at: Date.now() }); return; }
    seen.set(key, { at: Date.now(), conflicts, sha, failed: 0 });
  }
  if (conflicts !== null) save();
  tell();
}

/**
 * Whether what is held settles the question for this commit.
 *
 * An answer holds until the head commit moves — no clock: asking again about
 * the same commit is the flood this store exists to avoid. (The base moving
 * under an unchanged head is not seen here; the page's own reading and
 * GitHub's list catch it.) A "could not tell" is asked once more after
 * RETRY_MS and then left alone until the head moves.
 */
const fresh = (e: Entry, sha: string | null | undefined, now: number): boolean => {
  if (e.sha && sha && e.sha !== sha) return false;
  if (e.conflicts !== null) return true;
  return e.failed >= 2 || now - e.at < RETRY_MS;
};

/**
 * Ask, if nobody has lately. Called by whoever draws a card whose row says
 * UNKNOWN and is IN THE VIEWPORT (the caller observes that; a board of sixty is
 * not sixty questions). Never while the window is in the background.
 */
export function askConflict(root: string, row: Pick<PrSummary, "number" | "mergeable" | "headSha">): void {
  if (!root || !row.number || row.mergeable !== "UNKNOWN") return;
  load();
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
  load();
  const hit = seen.get(keyOf(root, row.number));
  if (hit && hit.conflicts === null && hit.failed >= 2 && !(hit.sha && row.headSha && hit.sha !== row.headSha)) return false; // gave up: say nothing
  return !hit || hit.conflicts === null || !fresh(hit, row.headSha, Date.now());
}

/**
 * The row with a conflict the page or the preview found written over GitHub's
 * UNKNOWN. Only that direction: a clean preview does not call a pull request
 * mergeable (checks and reviews are GitHub's), it just stops it saying
 * "checking". Same object back when nothing changes.
 */
export function withConflict<T extends Pick<PrSummary, "number" | "mergeable" | "headSha">>(root: string, p: T): T {
  if (!root || p.mergeable !== "UNKNOWN") return p;
  load();
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
  loaded = true;
  try { localStorage.removeItem(STORE_KEY); } catch { /* none */ }
}

/** The panel closed and opened again: memory is gone, what was persisted is not. */
export function reopenConflicts(): void {
  seen.clear();
  waiting.length = 0;
  loaded = false;
}
