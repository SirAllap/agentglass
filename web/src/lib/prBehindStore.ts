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
import type { PrLocalHead } from "../../../shared/types.ts";

/** Long enough that switching tabs does not re-ask, short enough that a branch
 *  somebody just updated stops claiming to be behind. */
const TTL_MS = 5 * 60_000;
/** At once. The server runs `gh` on one thread and the board is a glance, not a
 *  report — three keeps the queue moving without holding up anything else. */
const AT_ONCE = 3;

type Entry = { at: number; behind: number | null; local: PrLocalHead | null };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; root: string; number: number; force?: boolean }[] = [];
const listeners = new Set<() => void>();
let running = 0;

const keyOf = (root: string, number: number) => `${root}::${number}`;

const looking = () => typeof document === "undefined" || (!document.hidden && document.hasFocus());

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
    api.prBehind(job.root, job.number, job.force)
      .then((r) => { seen.set(job.key, { at: Date.now(), behind: r.ok ? (r.behind ?? 0) : null, local: r.ok ? (r.local ?? null) : null }); })
      // A failure is remembered too, as "no answer" — otherwise every render
      // queues the same doomed request again.
      .catch(() => { seen.set(job.key, { at: Date.now(), behind: null, local: null }); })
      .finally(() => { running--; inflight.delete(job.key); tell(); pump(); });
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
 * Nobody has an answer for this one yet.
 *
 * Told apart from "up to date" on purpose: both draw no chip, and only one of
 * them deserves the space kept for it. Twelve chips appearing one by one over a
 * few seconds is the board rearranging itself in slow motion.
 */
export function askingBehind(root: string, number: number): boolean {
  if (!root || !number) return false;
  const hit = seen.get(keyOf(root, number));
  return !hit || Date.now() - hit.at >= TTL_MS;
}

/**
 * The whole answer, for the caller that needs the local head as well.
 *
 * The pull request's own page used to ask for this itself, which meant the
 * board found out a branch was 222 behind and the page you opened from that
 * board went and asked again — seconds of nothing, over an answer already in
 * memory. One store, two readers.
 */
export function behindAnswer(root: string, number: number): { behind: number | null; local: PrLocalHead | null } {
  const behind = behindOf(root, number);
  const hit = seen.get(keyOf(root, number));
  return { behind, local: hit?.local ?? null };
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
 * you. Measured while he was looking at it: the server said 0 behind and GitHub
 * agreed, and the page went on showing 936 because this store was still inside
 * its own five minutes.
 */
export function refreshBehind(root: string, number: number, force = true): void {
  if (!root || !number) return;
  seen.delete(keyOf(root, number));
  behindOf(root, number, force);
}

/** Forget everything — for a test, or a repository that has just changed under
 *  the panel. */
export function forgetBehind(): void {
  seen.clear();
  waiting.length = 0;
}
