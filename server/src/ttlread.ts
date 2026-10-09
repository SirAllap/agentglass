// A read that is answered from memory for a while, and asked once when several
// callers want it in the same moment.
//
// Measured on the pull request panel: /prs/behind, /prs/rollup and the
// pull-request meta under "expand context" each cost one `gh` spawn per call
// and 100% of the repeats returned the same body, because nothing on the server
// remembered the answer and two callers a tick apart both asked GitHub.
//
// The ceiling: a TTL is a promise about how old an answer may be, not a check
// that it is still true. Callers pick a key that already contains what makes
// the answer change (a head sha, a ref) and pass `fresh` after a write of
// their own; anything that must be exact right now does not go through here.
import { singleFlight } from "./singleflight.ts";

type Entry = { at: number; value: unknown };
const memo = new Map<string, Entry>();
const MAX_ENTRIES = 400;

/**
 * `load` runs at most once per `ttlMs` for `key`, and once for overlapping
 * callers. A value `keep` refuses (a failed read) is shared with the callers
 * that were waiting but never remembered, so a blip is not cached.
 */
export async function ttlRead<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts: { fresh?: boolean; keep?: (v: T) => boolean } = {},
): Promise<T> {
  if (!opts.fresh) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  }
  // A forced read must not join a flight that started before the write that
  // made it necessary, so it gets a key of its own.
  const flightKey = opts.fresh ? `fresh:${key}` : `ttl:${key}`;
  return singleFlight(flightKey, async () => {
    const v = await load();
    if (!opts.keep || opts.keep(v)) {
      memo.set(key, { at: Date.now(), value: v });
      if (memo.size > MAX_ENTRIES) {
        for (const k of memo.keys()) { memo.delete(k); if (memo.size <= MAX_ENTRIES * 0.75) break; }
      }
    }
    return v;
  });
}

/** Forget every answer whose key starts with `prefix`, after a write. */
export function forgetReads(prefix: string): void {
  for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
}

export function __resetTtlReads(): void { memo.clear(); }
