/*
 * The failures read in this session, by job: so a check that was opened is open
 * instantly the second time, a row can say "2 failing tests" without being
 * opened, and two components asking for the same job make one request.
 *
 * The server keeps what it read (ci_failure_reads); this only keeps the client
 * from asking again. Nothing here runs on a timer and nothing here asks until
 * a failed check is opened (`load`) or a tab shows its rows (`loadCached`,
 * which the server answers from its own cache, not from GitHub).
 */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import type { CheckFailures, CheckFailureSummary } from "../../../shared/types.ts";

export const failureKey = (root: string, job: string) => `${root}#${job}`;

/** The two reads the store makes, so a test can hand it fakes instead of a server. */
export interface FailureSources {
  failures(root: string, job: string, hints: { attempt?: number; step?: string }, force: boolean): Promise<CheckFailures>;
  cached(root: string, jobs: string[]): Promise<{ ok: boolean; summaries?: Record<string, CheckFailureSummary>; error?: string }>;
}

export function makeFailureStore(src: FailureSources) {
  const reads = new Map<string, CheckFailures>();
  const summaries = new Map<string, CheckFailureSummary>();
  const asking = new Set<string>();
  /** Jobs the cache was already asked about: a job it did not know is not asked about again on every re-render. */
  const askedCache = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  const bump = () => { version++; for (const l of listeners) l(); };

  function readOf(key: string): CheckFailures | undefined { return reads.get(key); }
  function summaryOf(key: string): CheckFailureSummary | undefined { return summaries.get(key); }
  function isAsking(key: string): boolean { return asking.has(key); }

  /** Open a failed check: one request pair at most, and none when this session or the server already has it. */
  async function load(root: string, job: string, hints: { attempt?: number; step?: string }, force = false): Promise<void> {
    const key = failureKey(root, job);
    if (asking.has(key)) return;
    const have = reads.get(key);
    if (!force && have?.ok) return;
    asking.add(key); if (force || !have) reads.delete(key);
    bump();
    try {
      reads.set(key, await src.failures(root, job, hints, force));
    } catch {
      reads.set(key, { ok: false, kind: "error", error: "Could not reach the server", requests: 0 });
    } finally {
      asking.delete(key);
      bump();
    }
  }

  /** Rows of a Checks tab: what the server's cache already knows, in one request that never reaches GitHub. */
  async function loadCached(root: string, jobs: string[]): Promise<void> {
    const want = jobs.filter((j) => !askedCache.has(failureKey(root, j)) && !reads.get(failureKey(root, j))?.ok);
    if (!want.length) return;
    for (const j of want) askedCache.add(failureKey(root, j));
    try {
      const r = await src.cached(root, want);
      if (!r.ok || !r.summaries) return;
      for (const [job, s] of Object.entries(r.summaries)) summaries.set(failureKey(root, job), s);
      bump();
    } catch { /* a row that cannot be worded from the cache keeps the words it had */ }
  }

  /** Re-render when anything in the store moves. */
  function useStore(): number {
    return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => version);
  }

  /** Tests only. */
  function reset(): void { reads.clear(); summaries.clear(); asking.clear(); askedCache.clear(); bump(); }
  return { readOf, summaryOf, isAsking, load, loadCached, useFailureStore: useStore, reset };
}

const store = makeFailureStore({
  failures: (root, job, hints, force) => api.prCheckFailures(root, job, hints, force),
  cached: (root, jobs) => api.prCheckFailuresCached(root, jobs),
});
export const { readOf, summaryOf, isAsking, load, loadCached, useFailureStore } = store;
