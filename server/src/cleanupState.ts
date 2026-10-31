import { db } from "./db.ts";
import { forgetClosed } from "./prClosedStore.ts";

/** What agentglass keeps about a pull request that has been cleaned up: its closed-PR cache row and the status rows of agents in its checkout. Both are re-created by a later read. Returns the rows removed. */
export function forgetCleanedPr(a: { repo: string; pr: number; worktree: string | null }): number {
  return forgetClosed(a.repo, a.pr) + (a.worktree ? db.query(`DELETE FROM agent_status WHERE worktree = ?`).run(a.worktree).changes : 0);
}

/**
 * What the automatic mode did, one row per pull request: the Lantern's
 * Housekeeping entries and the PR badge's reason both read it. `cleaning` and
 * `cleaned` make a second run of the same pull request impossible; `blocked`
 * may be looked at again (a safety block can clear) but not within an hour.
 * Rows age out after 30 days. Ceiling: no history beyond that, and a failed
 * run is not retried by itself.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS cleanup_auto (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  state TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  freed INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (repo, pr)
);
`);

export type AutoState = "cleaning" | "cleaned" | "blocked" | "failed" | "nothing";
export interface AutoRow {
  repo: string; pr: number; state: AutoState; label: string; slug: string; title: string; reason: string;
  done: number; total: number; freed: number; report: string; started_at: number; ended_at: number | null;
}
const RECHECK_MS = 3_600_000;
const KEEP_MS = 30 * 86_400_000;

/* A run the app was closed in the middle of is a row nobody owns: `claimAuto` never takes a `cleaning` row, so it would sit in the limbo for ever.
   It becomes a blocked row long past its hour, marked so the next sweep resumes it: the engine re-plans and finishes what is left (steps already done are no longer there). */
export const INTERRUPTED = "interrupted when the app closed; resuming";
export const markInterrupted = (): void => { db.query(`UPDATE cleanup_auto SET state = 'blocked', reason = ?, started_at = 0 WHERE state = 'cleaning'`).run(INTERRUPTED); };
markInterrupted();
export const interruptedPrs = (repo: string): number[] =>
  db.query<{ pr: number }, [string, string]>(`SELECT pr FROM cleanup_auto WHERE repo = ? AND state = 'blocked' AND reason = ?`).all(repo, INTERRUPTED).map((r) => r.pr);

export const autoRow = (repo: string, pr: number): AutoRow | null =>
  db.query<AutoRow, [string, number]>(`SELECT * FROM cleanup_auto WHERE repo = ? AND pr = ?`).get(repo, pr);

/**
 * Claims the pull request for one run. False when it is already cleaning or
 * done (or nothing was left to clean), or was found blocked less than an hour
 * ago: the caller then does nothing.
 */
export function claimAuto(a: { repo: string; pr: number; label: string; slug: string; title: string; total: number; now: number }): boolean {
  db.query(`DELETE FROM cleanup_auto WHERE started_at < ?`).run(a.now - KEEP_MS);
  const r = db.query(
    `INSERT INTO cleanup_auto (repo, pr, state, label, slug, title, total, started_at) VALUES (?, ?, 'cleaning', ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr) DO UPDATE SET state = 'cleaning', label = excluded.label, slug = excluded.slug, title = excluded.title,
       reason = '', done = 0, total = excluded.total, freed = 0, report = '', started_at = excluded.started_at, ended_at = NULL
     WHERE cleanup_auto.state = 'blocked' AND cleanup_auto.started_at <= ?`,
  ).run(a.repo, a.pr, a.label, a.slug, a.title, a.total, a.now, a.now - RECHECK_MS);
  return r.changes === 1;
}
export const progressAuto = (repo: string, pr: number, done: number, total: number, freed: number): void => {
  db.query(`UPDATE cleanup_auto SET done = ?, total = ?, freed = ? WHERE repo = ? AND pr = ? AND state = 'cleaning'`).run(done, total, freed, repo, pr);
};
export function finishAuto(repo: string, pr: number, f: { state: Exclude<AutoState, "cleaning">; reason?: string; freed?: number; report?: unknown; now: number }): void {
  db.query(`UPDATE cleanup_auto SET state = ?, reason = ?, freed = ?, report = ?, ended_at = ? WHERE repo = ? AND pr = ?`)
    .run(f.state, f.reason ?? "", f.freed ?? 0, f.report === undefined ? "" : JSON.stringify(f.report), f.now, repo, pr);
}
/** A blocked pull request, recorded for the badge. Inserts when nothing was claimed; never overwrites a run. */
export function noteBlocked(a: { repo: string; pr: number; label: string; slug: string; title: string; reason: string; now: number }): void {
  db.query(
    `INSERT INTO cleanup_auto (repo, pr, state, label, slug, title, reason, started_at, ended_at) VALUES (?, ?, 'blocked', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr) DO UPDATE SET reason = excluded.reason, started_at = excluded.started_at, ended_at = excluded.ended_at WHERE cleanup_auto.state = 'blocked'`,
  ).run(a.repo, a.pr, a.label, a.slug, a.title, a.reason, a.now, a.now);
}
/** Newest first. `blocked` and `nothing` rows are for the badge and stay out of the Lantern list. */
export const autoRows = (limit = 20, repo?: string): AutoRow[] =>
  repo === undefined
    ? db.query<AutoRow, [number]>(`SELECT * FROM cleanup_auto ORDER BY started_at DESC LIMIT ?`).all(limit)
    : db.query<AutoRow, [string, number]>(`SELECT * FROM cleanup_auto WHERE repo = ? ORDER BY started_at DESC LIMIT ?`).all(repo, limit);
