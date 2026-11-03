/**
 * Is this reading of a pull request about the commit the pull request is on?
 *
 * The panel once said "Ready to merge · All checks have passed · 1 thread"
 * for the head BEFORE a push, while the new head had ~25 checks running and the
 * merge state was BLOCKED. Every piece was a true answer about an older commit:
 * the rollup comes off `commits(last:1)`, which can trail `headRefOid` after a
 * push, a cached detail outlives the push by up to 45 s, and a row or a watch
 * read could write checks over a detail without saying which commit they were.
 *
 * So a reading carries two commits, the head and the commit its checks belong
 * to, and one pure function decides whether it may say anything about merging.
 * A reading that may not is replaced by `trustHead` with one that says
 * "checking the new head" and offers nothing to press.
 */
import type { PrCheckRollup, PrDetail } from "./types.ts";

/** After our own push, a read whose head is not the pushed commit is GitHub lagging, not someone else's push. */
export const PUSH_SETTLE_MS = 120_000;

export interface PushSeen { sha: string; at: number }
export type Staleness = "ok" | "no-head" | "checks-older" | "before-push" | "lagging-push";

const same = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
export const shortSha = (s: string | undefined): string => (s ?? "").slice(0, 7);

export function staleness(
  d: Pick<PrDetail, "headSha" | "checksSha" | "readAt">,
  push?: PushSeen | null,
  now = Date.now(),
): Staleness {
  if (!d.headSha) return "no-head";
  if (!d.checksSha || !same(d.checksSha, d.headSha)) return "checks-older";
  if (push) {
    if (d.readAt != null && d.readAt < push.at) return "before-push";
    if (!same(push.sha, d.headSha) && now - push.at < PUSH_SETTLE_MS) return "lagging-push";
  }
  return "ok";
}

const NONE: PrCheckRollup = { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] };

/**
 * The reading as the panel may show it. Fresh: itself. Otherwise the parts that
 * belong to another commit are taken away at once (checks, merge state, threads), so
 * no surface can read "Ready to merge" or enable Merge from them.
 */
export function trustHead<T extends PrDetail>(d: T, push?: PushSeen | null, now = Date.now()): T {
  const why = staleness(d, push, now);
  if (why === "ok") return d;
  const sha = shortSha(push && why !== "checks-older" && why !== "no-head" ? push.sha : d.headSha);
  return { ...d, mergeState: "UNKNOWN", mergeable: "UNKNOWN", checks: NONE, checksAll: [], threads: [], openThreads: undefined, checking: { sha, why } };
}

export const POLL_RUNNING_MS = 30_000;
export const POLL_CAP_MS = 90 * 60_000;

/**
 * When to look again at the pull request on screen, or null for never.
 * Events come first (hooks, notifications); this is only for an open PR whose
 * checks are running or whose reading is not current. Nothing while hidden.
 */
export function nextLook(
  d: Pick<PrDetail, "headSha" | "checksSha" | "readAt" | "checks" | "state">,
  o: { visible: boolean; since: number; now?: number; push?: PushSeen | null },
): number | null {
  const now = o.now ?? Date.now();
  if (!o.visible || d.state !== "OPEN" || now - o.since > POLL_CAP_MS) return null;
  const settled = staleness(d, o.push, now) === "ok" && d.checks.pending === 0 && d.checks.total > 0;
  return settled ? null : POLL_RUNNING_MS;
}

/**
 * The board's version of the question. A row's checks come off the same commit
 * as its `headSha` by construction, so only a push can make them old: the short
 * sha to wait for, or null when the row may be filed on what it says.
 */
export function rowChecking(p: { headSha?: string; readAt?: number; pushSeen?: PushSeen }, now = Date.now()): string | null {
  if (!p.pushSeen || !p.headSha) return null;
  return staleness({ headSha: p.headSha, checksSha: p.headSha, readAt: p.readAt }, p.pushSeen, now) === "ok" ? null : shortSha(p.pushSeen.sha);
}
