// The truth about a card's checks, when the list's own answer is suspect.
//
// GitHub's aggregate counts a re-run's old attempt beside the new one, so a
// pull request their page calls "All checks have passed" comes back to us with
// a FAILURE in the counts — and even their `state` field agrees with the
// counts, because their page does not use it either. Measured on a real one:
// counts of 45 SUCCESS, 20 SKIPPED, 1 CANCELLED, 1 FAILURE, state FAILURE, and
// a green tick on github.com.
//
// The list cannot fix this: aggregates have no names to de-duplicate by. So a
// card that claims failure asks — one pull request, one call, only while it is
// on screen, and remembered.

import { api } from "./api.ts";
import type { PrCheckRollup } from "../../../shared/types.ts";

/** Short: a check that fails now is news, and a re-run lands in seconds. */
const TTL_MS = 60_000;
const AT_ONCE = 2;

type Entry = { at: number; checks: PrCheckRollup | null };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; root: string; number: number }[] = [];
const listeners = new Set<() => void>();
let running = 0;

const keyOf = (root: string, number: number) => `${root}::${number}`;
const tell = () => { for (const l of listeners) l(); };

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const job = waiting.shift()!;
    running++;
    inflight.add(job.key);
    api.prRollup(job.root, job.number)
      .then((r) => { seen.set(job.key, { at: Date.now(), checks: r.ok ? (r.checks ?? null) : null }); })
      .catch(() => { seen.set(job.key, { at: Date.now(), checks: null }); })
      .finally(() => { running--; inflight.delete(job.key); tell(); pump(); });
  }
}

export function onRollup(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The checked answer, or null while nobody has one.
 *
 * Asking is the side effect, as with `behindOf`: the thing that knows a card is
 * on screen is the card. Only worth calling for a card whose list rollup claims
 * a failure — everything else is already telling the truth.
 */
export function rollupOf(root: string, number: number): PrCheckRollup | null {
  if (!root || !number) return null;
  const key = keyOf(root, number);
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.checks;
  if (!inflight.has(key) && !waiting.some((w) => w.key === key)) {
    waiting.push({ key, root, number });
    pump();
  }
  return hit?.checks ?? null;
}

export function forgetRollups(): void {
  seen.clear();
  waiting.length = 0;
}
