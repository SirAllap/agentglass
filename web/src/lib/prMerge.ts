// Never replace an answer with "not yet".
//
// The pull request list arrives in two passes on purpose: the rows in about a
// second and a half, the check rollups four seconds behind them, because the
// rollup is a separate walk per pull request and nobody opening the panel is
// waiting for it. A row from the first pass carries `checksLoaded: false` and
// an empty rollup — and zeroes for the diff stats, which come back in the same
// second pass.
//
// That is fine the first time. It is not fine on the fourth: every later fetch
// starts at the fast pass too, so a board that had the real answer on screen
// replaced it with the empty one and got it back a few seconds later. Reported
// from the app as the board loading correctly, going blank-ish — every card
// reading "Still reading its checks" — and then coming right on its own.
//
// So a refresh may add and it may correct, but it may not un-know: where the
// new row says the second pass has not run and the old row had it, the old
// answer stands until a real one replaces it.

import type { PrSummary } from "../../../shared/types.ts";

/**
 * The fields that only exist once the second pass has landed.
 *
 * Measured against the running server, sampling a forced refresh: the early
 * rows come back with the rollup empty, the diff stats zero, `reviewDecision`
 * null and `mergeable` UNKNOWN. The first three were on this list; the last two
 * were not, and they are the ones the board files a card by — which is why
 * approved-and-green cards still jumped lanes for a second and a half after
 * this merge was written.
 */
/*
 * `talk` is on this list because it was reported missing from a card that looked
 * complete: the pull request said "2 new" in its own conversation and the board
 * card beside it wore no badge at all. Everything else on the card was right —
 * the checks, the stats, the reviewers — because they were all being carried over
 * from the previous answer by this very function, and the conversation was the
 * one field it did not know to carry. So the row was whole to look at and had no
 * opinion about what had been said.
 */
/*
 * EVERY FIELD THE SECOND PASS FILLS, and the list has to stay complete.
 *
 * A row arrives twice: the bare row first, the rest a moment later. This is
 * what gets carried across so a refresh does not blank a card back to its first
 * pass — and a field added to the second pass but forgotten HERE disappears on
 * every refresh and comes back a second later, which is precisely what he saw:
 * "the cards stay like that… and when I hit refresh they stay like that again
 * until they load".
 *
 * `humanReview` and `card` were exactly that: shipped in the second pass, never
 * added to this list, so the board lost its verdict header and its tracker line
 * on every single poll. The lock beside this file derives the list from
 * `SecondPass` in prs.ts rather than trusting anybody to remember.
 */
const SECOND_PASS = ["checks", "checksLoaded", "additions", "deletions", "changedFiles",
  "reviewDecision", "humanReview", "card", "mergeable", "reviewers", "headSha", "talk", "openThreads"] as const;

export function keepLoadedChecks(prev: PrSummary[], next: PrSummary[]): PrSummary[] {
  if (!prev.length || !next.length) return next;
  const had = new Map<number, PrSummary>();
  for (const p of prev) if (p.checksLoaded !== false) had.set(p.number, p);
  if (!had.size) return next;

  let changed = false;
  const out = next.map((p) => {
    // `undefined` means this row was never built in two passes — a caller with
    // one pass is not missing anything and must not be patched from history.
    if (p.checksLoaded !== false) return p;
    const old = had.get(p.number);
    if (!old) return p;
    changed = true;
    const merged = { ...p } as Record<string, unknown>;
    for (const k of SECOND_PASS) merged[k] = (old as unknown as Record<string, unknown>)[k];
    return merged as unknown as PrSummary;
  });
  // Same array when nothing was carried over, so a re-render is not provoked by
  // a fetch that changed nothing.
  return changed ? out : next;
}
