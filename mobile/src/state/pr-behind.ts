/*
 * How far behind its base each branch is, fetched only for the cards on screen.
 *
 * It is not on the list payload and cannot be: `mergeStateStatus` reports BEHIND
 * only where the repository requires branches to be up to date before merging —
 * measured on a real pull request whose branch was 194 commits behind and still
 * reported CLEAN — so the honest answer costs a comparison per pull request.
 *
 * A dozen of those on every board paint would undo the thing this board is for,
 * so they are asked for lazily, three at a time, and remembered for five
 * minutes. What is not known yet is drawn as "checking" rather than "0 behind":
 * a card that claims the branch is current while the answer is in flight is
 * worse than a card that has not said anything. The shape is the desktop's
 * (`web/src/lib/prBehindStore.ts`), keyed by computer as well because two paired
 * phones can hold the same repository path.
 *
 * Asking is the side effect of `of`, deliberately: the thing that knows a card
 * is on screen is the card.
 */
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";

/** Long enough that moving between lanes does not re-ask, short enough that a
 *  branch somebody just updated stops claiming to be behind. */
export const BEHIND_TTL_MS = 5 * 60_000;
/** At once. The server runs `gh` on one thread and the board is a glance, not a
 *  report — three keeps the queue moving without holding up anything else. */
const AT_ONCE = 3;

export interface BehindAnswer {
  ok: boolean;
  behind?: number;
  error?: string;
}

type Entry = { at: number; behind: number | null; ok: boolean };

/** One store per module, or one of your own with an injected reader and clock. */
export function createBehindStore(
  read: (host: Host, root: string, number: number) => Promise<BehindAnswer>,
  now: () => number = Date.now,
) {
  const seen = new Map<string, Entry>();
  const inflight = new Set<string>();
  const waiting: { key: string; host: Host; root: string; number: number }[] = [];
  const listeners = new Set<() => void>();
  let running = 0;
  let version = 0;

  const keyOf = (host: Host, root: string, number: number): string =>
    `${host.origin}\n${host.token}\n${root}::${number}`;

  function tell(): void {
    version++;
    for (const l of listeners) l();
  }

  function pump(): void {
    while (running < AT_ONCE && waiting.length) {
      const job = waiting.shift()!;
      running++;
      inflight.add(job.key);
      read(job.host, job.root, job.number)
        .then((r) => { seen.set(job.key, { at: now(), behind: r.ok ? (r.behind ?? 0) : null, ok: r.ok }); })
        // A failure is remembered too, as "no answer" — otherwise every render
        // queues the same doomed request again.
        .catch(() => { seen.set(job.key, { at: now(), behind: null, ok: false }); })
        .finally(() => { running--; inflight.delete(job.key); tell(); pump(); });
    }
  }

  function of(host: Host | null, root: string, number: number): number | null {
    if (!host || !root || !number) return null;
    const key = keyOf(host, root, number);
    const hit = seen.get(key);
    if (hit && now() - hit.at < BEHIND_TTL_MS) return hit.behind;
    if (!inflight.has(key) && !waiting.some((w) => w.key === key)) {
      waiting.push({ key, host, root, number });
      pump();
    }
    // The last answer stands while the new one is out: "up to date" must not
    // flash to "checking" every five minutes a board is left open.
    return hit?.behind ?? null;
  }

  /** The answer already held, and no ask. */
  function known(host: Host | null, root: string, number: number): number | null {
    if (!host || !root || !number) return null;
    return seen.get(keyOf(host, root, number))?.behind ?? null;
  }

  /** Nobody has an answer for this one yet — told apart from a failed compare,
   *  which is an answer. Only a first look keeps the space. */
  function asking(host: Host | null, root: string, number: number): boolean {
    if (!host || !root || !number) return false;
    return !seen.has(keyOf(host, root, number));
  }

  /**
   * The last look came back with nothing, so there is no count to draw.
   *
   * Kept apart from `asking` on purpose: "the compare failed" and "the compare
   * has not answered yet" are different facts, and neither is "0 behind".
   */
  function failed(host: Host | null, root: string, number: number): boolean {
    if (!host || !root || !number) return false;
    const hit = seen.get(keyOf(host, root, number));
    return !!hit && !hit.ok;
  }

  /** Forget one computer's answers (or every computer's, with no host). */
  function forget(host?: Host | null): void {
    if (!host) { seen.clear(); waiting.length = 0; tell(); return; }
    const prefix = `${host.origin}\n${host.token}\n`;
    // Deleting while iterating a Map's keys is defined: no entry added later in
    // the same run is visited, and every key present is.
    for (const key of seen.keys()) if (key.startsWith(prefix)) seen.delete(key);
    tell();
  }

  return {
    /** Changes when an answer lands: the snapshot for `useSyncExternalStore`. */
    version: (): number => version,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    of,
    known,
    asking,
    failed,
    forget,
  };
}

const store = createBehindStore(async (host, root, number) => {
  const answer = await ask<{ ok: boolean; behind?: number; error?: string }>(
    host, `/prs/behind?root=${encodeURIComponent(root)}&number=${encodeURIComponent(String(number))}`,
  );
  return answer.ok ? answer.value : { ok: false, error: answer.error };
});

/** How far behind, or null while nobody knows. Asking is the side effect. */
export const behindOf = store.of;
export const knownBehind = store.known;
export const askingBehind = store.asking;
/** The last compare for this one failed: there is no count, and none is claimed. */
export const behindFailed = store.failed;
export const forgetBehind = store.forget;
export const behindVersion = store.version;
export const subscribeBehind = store.subscribe;
