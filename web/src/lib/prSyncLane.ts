// "Sync N" in a lane header: which of that lane's pull requests it will touch,
// which it leaves alone and why, and what the list says when some of them fail.
//
// The rules are not restated here. The per-card Update control already decides
// whether a branch may be updated (`updateGate` in prCardView.ts), and a lane
// sync runs exactly the card's action — merge the base into the head on GitHub,
// fast-forward the local copy only when it is clean (`updateBranch.ts`). This
// module adds only what a batch has that a card does not: the lane's boundary,
// the pull requests that are somebody else's, and the fact that one is already
// in flight.
//
// Scope is the whole safety story: a lane sync never sees a row from another
// lane, so "Sync the board" cannot be spelled by accident.
import type { PrSummary } from "../../../shared/types.ts";
import { updateGate } from "./prCardView.ts";
import type { LaneId } from "./prLanes.ts";

export type SyncReason =
  | "someone-else" | "finished" | "draft" | "read-only" | "conflict"
  | "syncing" | "behind-unknown" | "up-to-date";

/** Why a pull request stays out of the run. Short enough for a folded row. */
export const SYNC_REASON: Record<SyncReason, string> = {
  "someone-else": "someone else's",
  finished: "finished",
  draft: "draft",
  "read-only": "read-only",
  conflict: "conflicts with the base",
  syncing: "already syncing",
  "behind-unknown": "behind unknown",
  "up-to-date": "up to date",
};

export interface SyncFacts {
  author: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  baseRefName: string;
  headRefName: string;
  /** Commits the base has that this branch lacks; null while nobody knows. */
  behind: number | null;
}

export interface SyncVerdict {
  eligible: boolean;
  reason: SyncReason | null;
}

/**
 * One pull request, decided on its own: whose it is, whether it is finished,
 * whether an update is already in flight, then the card's own Update gate and
 * nothing else — `mergeable: "UNKNOWN"` is not a refusal, since the gate offers
 * Update and `gh pr update-branch` reports a conflict itself.
 */
export function syncVerdict(f: SyncFacts, o: { viewer: string; readOnly?: boolean; syncing?: boolean }): SyncVerdict {
  if (!o.viewer || f.author !== o.viewer) return { eligible: false, reason: "someone-else" };
  if (f.state !== "OPEN") return { eligible: false, reason: "finished" };
  /* Before the gate: an update in flight forgets the behind count it just made
     obsolete, and "behind unknown" would name the wrong reason for leaving it out. */
  if (o.syncing) return { eligible: false, reason: "syncing" };
  const gate = updateGate(f, f.behind, !!o.readOnly);
  /* "up to date" is where the gate puts a branch nobody has compared yet; the
     list can say which of the two it is. */
  if (!gate.offered) {
    const reason: SyncReason = gate.reason === "up-to-date" && f.behind === null ? "behind-unknown" : gate.reason!;
    return { eligible: false, reason };
  }
  return { eligible: true, reason: null };
}

export interface SyncPlanRow {
  p: Pick<PrSummary, "number" | "title" | "author" | "state" | "isDraft" | "mergeable" | "baseRefName" | "headRefName">;
  filed: { lane: LaneId };
}

export interface SyncItem {
  number: number;
  title: string;
  behind: number;
  headRefName: string;
}

export interface SyncPlan {
  /** In lane order, so the list reads like the column it came from. */
  eligible: SyncItem[];
  skipped: { number: number; title: string; reason: SyncReason }[];
}

/**
 * What a lane's button would do, before it does anything.
 *
 * `rows` is the whole board: only rows filed in `lane` are read, so a caller
 * that hands over everything cannot widen the blast radius. Rows from other
 * lanes are not "skipped" — they are not this lane's business, and listing them
 * as left alone would read as though the button had considered them.
 */
export function laneSyncPlan(lane: LaneId, rows: readonly SyncPlanRow[], o: {
  viewer: string;
  readOnly?: boolean;
  syncing?: ReadonlySet<number>;
  behindOf: (n: number) => number | null;
}): SyncPlan {
  const plan: SyncPlan = { eligible: [], skipped: [] };
  for (const row of rows) {
    if (row.filed.lane !== lane) continue;
    const facts: SyncFacts = {
      author: row.p.author, state: row.p.state, isDraft: row.p.isDraft,
      mergeable: row.p.mergeable, baseRefName: row.p.baseRefName, headRefName: row.p.headRefName,
      behind: o.behindOf(row.p.number),
    };
    const v = syncVerdict(facts, { viewer: o.viewer, readOnly: o.readOnly, syncing: !!o.syncing?.has(row.p.number) });
    if (v.eligible) plan.eligible.push({ number: row.p.number, title: row.p.title, behind: facts.behind!, headRefName: row.p.headRefName });
    else plan.skipped.push({ number: row.p.number, title: row.p.title, reason: v.reason! });
  }
  return plan;
}

export type SyncStatus = "done" | "failed";

export interface SyncResult {
  number: number;
  title: string;
  status: SyncStatus;
  /** The server's sentence when it failed, or the local copy's fate when it did not. */
  detail: string;
}

/** What one press did, once every eligible one has been tried. */
export interface SyncTally {
  done: number;
  failed: number;
  /** Pull requests left out before the run began (drafts, others', conflicts…). */
  left: number;
  ok: boolean;
  text: string;
}

/**
 * The closing sentence. A failure is named with its number: "1 failed" over a
 * list of seven makes somebody hunt for which one.
 */
export function syncTally(results: readonly SyncResult[], left: number): SyncTally {
  const done = results.filter((r) => r.status === "done").length;
  const failed = results.filter((r) => r.status === "failed");
  const ok = failed.length === 0;
  const rest = left ? ` · ${left} left alone` : "";
  return {
    done, failed: failed.length, left, ok,
    text: ok
      ? `Synced ${done}${rest}`
      : `${done} synced · ${failed.length} failed (${failed.map((f) => `#${f.number}`).join(", ")})${rest}`,
  };
}

/** At most this many at once: each one is a `gh` round trip on one server thread, and a failure must not take the others with it. */
export const SYNC_AT_ONCE = 3;

/**
 * What a retry runs: the ones that failed, and only those.
 *
 * The button says "Retry the failed", but the plan it re-ran was the whole
 * pre-run list, so every branch that had already moved got a second
 * `gh pr update-branch`; the repeats came back "head sha didn't match" and the
 * tally said "1 synced · 4 failed" over four branches that had updated fine.
 */
export function retryItems(plan: SyncPlan, results: readonly SyncResult[]): SyncItem[] {
  const out: SyncItem[] = [];
  for (const r of results) {
    if (r.status !== "failed") continue;
    const it = plan.eligible.find((i) => i.number === r.number);
    if (it) out.push(it);
  }
  return out;
}

/**
 * The one a card's Retry presses, built from the row that card already has.
 *
 * The plan is live and it empties as the press works: a row GitHub just refused
 * comes back as a conflict and leaves it, so looking the item up there is what
 * made the press do nothing. `behind` is only the list's badge, and a retried
 * row is no longer in that list.
 */
export function retryFromRow(row: SyncPlanRow | undefined, behindOf: (n: number) => number | null): SyncItem | null {
  if (!row) return null;
  return {
    number: row.p.number,
    title: row.p.title,
    behind: behindOf(row.p.number) ?? 0,
    headRefName: row.p.headRefName,
  };
}

/** What a new press leaves of the old answers: a retried number would count as done the moment it began. */
export function withoutResults(prev: SyncResult[] | null, items: readonly { number: number }[]): SyncResult[] | null {
  return prev?.filter((x) => !items.some((i) => i.number === x.number)) ?? null;
}

/**
 * One card's Retry at a time, the rest waiting their turn.
 *
 * Two failed cards pressed a second apart: the second press returned with no
 * send, no sentence and no change on its card, while the card still looked
 * pressable. A press for a number already in the line is that same send twice
 * and is refused — its card already says Waiting or Merging.
 */
export function serialRetry() {
  const line = new Set<number>();
  let tail: Promise<void> = Promise.resolve();
  return (n: number, run: () => Promise<void>, waited?: () => void): Promise<void> | null => {
    if (line.has(n)) return null;
    const behind = line.size > 0;
    line.add(n);
    const next = tail.then(async () => {
      try { await run(); } finally { line.delete(n); }
    });
    tail = next.catch(() => {});
    if (behind) waited?.();
    return next;
  };
}

/**
 * The list's confirm, off for the reasons the rows already give.
 *
 * `retrying` is a card's Retry: the same press on the same number, so a press
 * here would be refused by that flight and flip the row to failed over a merge
 * that is running.
 */
export function confirmOff(o: { running: boolean; retrying: number | null; queued?: number; items: readonly SyncItem[]; ok: boolean }): boolean {
  return o.running || o.retrying !== null || !!o.queued || !o.items.length || o.ok;
}

/**
 * What a card's Retry says in the open list: the one running is merging, and the
 * ones behind it are waiting their turn rather than idle.
 */
export function retryRow(retrying: number | null, queued: ReadonlySet<number>, n: number): "merging" | "waiting" | null {
  if (retrying === n) return "merging";
  return queued.has(n) ? "waiting" : null;
}

/**
 * The confirm's sentence. A failed row GitHub refused has left the plan, so it
 * has no item to send: "Retry the 0 failed" would name a press this button cannot make.
 */
export function confirmLabel(t: SyncTally | null, again: readonly SyncItem[], eligible: number): string {
  if (!t || t.ok) return `Sync ${eligible}`;
  if (!again.length) return "Retry on its card";
  return `Retry the ${again.length === 1 ? "failed one" : `${again.length} failed`}`;
}

/** One answer folded into what is already known: a retry adds to the first press's successes instead of starting the tally again. */
export function mergeResult(prev: readonly SyncResult[], r: SyncResult): SyncResult[] {
  return [...prev.filter((x) => x.number !== r.number), r];
}

/**
 * Run `run` over every item, three at a time.
 *
 * A rejection is a failed row, not a thrown batch: the press is "update these",
 * and one branch GitHub refuses is no reason to leave the six behind it alone.
 * Results keep the plan's order so the list does not reshuffle as answers land.
 * `onItem` fires as each answer lands, so the list, the count and the bar move
 * during a run that takes 15-25 s rather than all at once at the end.
 * `onStart` fires as a worker picks a row up: three at a time means seven of
 * ten sit waiting, and a card cannot say which without being told.
 */
export async function runLaneSync(
  items: readonly { number: number; title: string }[],
  run: (number: number) => Promise<{ ok: boolean; detail?: string }>,
  onItem?: (r: SyncResult) => void,
  onStart?: (number: number) => void,
): Promise<SyncResult[]> {
  const out: SyncResult[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i]!;
      onStart?.(it.number);
      let r: SyncResult;
      try {
        const a = await run(it.number);
        r = { number: it.number, title: it.title, status: a.ok ? "done" : "failed", detail: a.detail ?? (a.ok ? "updated" : "failed") };
      } catch (e) {
        r = { number: it.number, title: it.title, status: "failed", detail: String(e) };
      }
      out[i] = r;
      onItem?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_AT_ONCE, items.length) }, worker));
  return out;
}
