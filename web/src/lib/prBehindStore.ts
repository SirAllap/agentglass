// How far behind its base each branch is, fetched only when somebody can see it.
//
// It is not on the list payload and cannot be: `mergeStateStatus` reports BEHIND
// only where the repository requires branches to be up to date before merging —
// measured on a real pull request whose branch was 194 commits behind and still
// reported CLEAN — so the honest answer costs a comparison per pull request.
//
// A dozen of those on every board paint would undo the thing this board is for,
// so they are asked for lazily, a few at a time, and remembered. What is not
// known yet is drawn as nothing at all: a card that says "0 behind" while the
// answer is in flight is worse than a card that has not said anything.

import { api } from "./api.ts";
import { isLooking } from "./usePoll.ts";
import type { PrLocalHead } from "../../../shared/types.ts";

/** Long enough that switching tabs does not re-ask, short enough that a branch
 *  somebody just updated stops claiming to be behind. */
const TTL_MS = 5 * 60_000;
/** At once. The server runs `gh` on one thread and the board is a glance, not a
 *  report — three keeps the queue moving without holding up anything else. */
const AT_ONCE = 3;

type Entry = { at: number; behind: number | null; local: PrLocalHead | null; refSha?: string | null };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; root: string; number: number; force?: boolean }[] = [];
const listeners = new Set<() => void>();
/** Bumped by a forced refresh: an answer asked for before it is about the branch as it WAS (before an Update branch) and must not be kept. */
const generation = new Map<string, number>();
let running = 0;

const keyOf = (root: string, number: number) => `${root}::${number}`;

const looking = () => typeof document === "undefined" || isLooking(document.hidden);

function tell(): void {
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => tell());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tell(); });
}

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const job = waiting.shift()!;
    running++;
    inflight.add(job.key);
    const gen = generation.get(job.key) ?? 0;
    const current = () => (generation.get(job.key) ?? 0) === gen;
    api.prBehind(job.root, job.number, job.force)
      .then((r) => { if (current()) seen.set(job.key, { at: Date.now(), behind: r.ok ? (r.behind ?? 0) : null, local: r.ok ? (r.local ?? null) : null, refSha: r.ok ? (r.refSha ?? null) : null }); })
      // A failure is remembered too, as "no answer" — otherwise every render
      // queues the same doomed request again.
      .catch(() => { if (current()) seen.set(job.key, { at: Date.now(), behind: null, local: null }); })
      .finally(() => {
        running--; inflight.delete(job.key);
        /* Asked before the refresh that superseded it: drop it and ask again, so the card and the page cannot end on the old count. */
        if (!current()) waiting.push({ ...job, force: true });
        tell(); pump();
      });
  }
}

/** Subscribe to answers landing. Returns the unsubscribe. */
export function onBehind(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * How far behind, or null while nobody knows.
 *
 * Asking is the side effect: calling this for a pull request nothing has asked
 * about yet puts it in the queue. That is deliberate — the thing that knows a
 * card is on screen is the card.
 */
export function behindOf(root: string, number: number, force = false): number | null {
  if (!root || !number) return null;
  const key = keyOf(root, number);
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.behind;
  /* Not while nobody is looking. Every render calls this, so an answer that
     aged out queued a comparison from a window in the background: measured as
     one `gh` spawn per card per five minutes on an unfocused board. Coming back
     rings `tell()` (below) and the re-render asks then. A first look, with
     nothing held, is always allowed. */
  if (hit && !looking()) return hit.behind;
  if (!inflight.has(key) && !waiting.some((w) => w.key === key)) {
    waiting.push({ key, root, number, force });
    pump();
  }
  return hit?.behind ?? null;
}

/**
 * The answer already held, and no ask.
 *
 * A lane header counts from the rows the board has already drawn; `behindOf`
 * queues a comparison per call, so reading a whole lane through it spent one
 * `gh` spawn on every pull request nobody had looked at yet. The header reads
 * what the cards asked for and nothing more.
 */
export function knownBehind(root: string, number: number): number | null {
  if (!root || !number) return null;
  return seen.get(keyOf(root, number))?.behind ?? null;
}

/**
 * Nobody has an answer for this one yet.
 *
 * Told apart from "up to date" on purpose: both draw no chip, and only one of
 * them deserves the space kept for it. Twelve chips appearing one by one over a
 * few seconds is the board rearranging itself in slow motion.
 */
export function askingBehind(root: string, number: number): boolean {
  if (!root || !number) return false;
  /* Only a FIRST look keeps the space. An answer past its five minutes is still
     an answer — `behindOf` goes on returning it while it is asked again — so a
     card that read "up to date" must not turn into a pulsing grey box on every
     expiry, which on an unfocused window (it does not re-ask there) stayed grey
     until somebody came back. */
  return !seen.has(keyOf(root, number));
}

/**
 * The whole answer, for the caller that needs the local head as well.
 *
 * The pull request's own page used to ask for this itself, which meant the
 * board found out a branch was 222 behind and the page you opened from that
 * board went and asked again — seconds of nothing, over an answer already in
 * memory. One store, two readers.
 */
export function behindAnswer(root: string, number: number): { behind: number | null; local: PrLocalHead | null; refSha: string | null; at: number } {
  const behind = behindOf(root, number);
  const hit = seen.get(keyOf(root, number));
  return { behind, local: hit?.local ?? null, refSha: hit?.refSha ?? null, at: hit?.at ?? 0 };
}

/**
 * Throw one away — after an "Update branch", where the count we are holding is
 * exactly the thing that just stopped being true.
 */
export function forgetOneBehind(root: string, number: number): void {
  seen.delete(keyOf(root, number));
  tell();
}

/**
 * Ask again for one, now.
 *
 * The count is cached for five minutes because it costs a comparison over the
 * network — right for a board of twelve, wrong for the pull request in front of
 * you. Measured with the pull request open: the server said 0 behind and GitHub
 * agreed, and the page went on showing 936 because this store was still inside
 * its own five minutes.
 */
export function refreshBehind(root: string, number: number, force = true): void {
  if (!root || !number) return;
  const key = keyOf(root, number);
  generation.set(key, (generation.get(key) ?? 0) + 1);
  seen.delete(key);
  /* Told, so the page drops the count it holds in state: otherwise it keeps saying 7 while the card, reading the store, has nothing. */
  tell();
  behindOf(root, number, force);
}

/** Forget everything — for a test, or a repository that has just changed under
 *  the panel. */
export function forgetBehind(): void {
  seen.clear();
  generation.clear();
  waiting.length = 0;
}

/**
 * A held answer by pull request number alone, for a reader that has no checkout path (the Jira tile). Read-only: it never asks.
 * Two checkouts holding the same number with different answers is not an answer, so it says null then.
 */
export function knownBehindByNumber(number: number): number | null {
  if (!number) return null;
  const tail = `::${number}`;
  const found = new Set<number>();
  for (const [k, v] of seen) if (k.endsWith(tail) && v.behind !== null) found.add(v.behind);
  return found.size === 1 ? [...found][0]! : null;
}
