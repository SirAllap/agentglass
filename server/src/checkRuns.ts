// Every finished check run the app reads, kept per repository.
//
// The Checks tab needs "is this run normal?", and the answer is the same job on
// earlier runs of ANY pull request of the repo, so the history is per repo and
// per check key (workflow, job, trigger), not per pull request. It is fed by
// the check reads the app already makes, so it costs no GitHub request; the
// ceiling is that a repo only learns from pull requests somebody opened here.
//
// Every conclusion is stored (the CI metrics view wants the failure rate and
// which runs share a commit), the baseline reads successes only. Retention:
// RUN_DAYS or RUNS_PER_KEY runs, whichever bites first.
import { db } from "./db.ts";
import type { PrCheck } from "../../shared/types.ts";
import { runKey, baselineStats, aggregateRuns, BASELINE_RUNS, type CheckMetric, type StoredRun } from "../../shared/checkBaseline.ts";

export const RUN_DAYS = 90;
export const RUNS_PER_KEY = 200;

db.exec(`
CREATE TABLE IF NOT EXISTS check_runs (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pr INTEGER,
  sha TEXT NOT NULL DEFAULT '',
  conclusion TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  attempt INTEGER,
  PRIMARY KEY (repo, key, run_id)
);
CREATE INDEX IF NOT EXISTS check_runs_by_key ON check_runs (repo, key, completed_at DESC);
`);
// The commit the run was for, read in the same response as the run itself. `sha`
// above is the older column and is no longer written: it came from the list
// cache, which can be a push behind, so a run of the new commit could be filed
// under the old one. Rows written before this column stay '' and are shown as
// "not judged", never guessed.
try { db.exec("ALTER TABLE check_runs ADD COLUMN head_sha TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }

const keyOf = (c: PrCheck) => runKey(c.workflow, c.name, c.event);
/** The job's own URL is unique per run; a rerun is a new job. Without one, the finish time tells runs apart. */
const runIdOf = (c: PrCheck) => c.url || `t${c.completedAt}`;
const attemptOf = (c: PrCheck): number | null => {
  const m = /\/attempts\/(\d+)/.exec(c.url || "");
  return m ? Number(m[1]) : null;
};

/** A finished run worth keeping: it ran (not skipped), and both times are known. */
export function storable(c: PrCheck): { conclusion: StoredRun["conclusion"]; started: number; completed: number } | null {
  if (!c.done || c.state === "skipped" || c.state === "neutral" || c.state === "pending") return null;
  const started = Date.parse(c.startedAt || ""), completed = Date.parse(c.completedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) return null;
  return { conclusion: c.state === "success" ? "success" : c.cancelled ? "cancelled" : "failure", started, completed };
}

/**
 * Store what this read shows and prune the keys it touched. `sha` is the head
 * commit the GitHub response itself named for these checks; empty when it did
 * not, and those runs are not judged for re-runs. A run already stored
 * without a commit gets it from a later read of the same job, and that counts
 * in the number returned like a new one.
 */
export function recordRuns(repo: string, pr: number | null, sha: string, all: PrCheck[], now = Date.now()): number {
  const rows = all.map((c) => ({ c, s: storable(c) })).filter((x): x is { c: PrCheck; s: NonNullable<ReturnType<typeof storable>> } => !!x.s);
  if (!rows.length) return 0;
  const ins = db.prepare(`INSERT INTO check_runs (repo, key, run_id, pr, head_sha, conclusion, started_at, completed_at, ms, attempt) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (repo, key, run_id) DO UPDATE SET head_sha = excluded.head_sha WHERE check_runs.head_sha = '' AND excluded.head_sha <> ''`);
  const prune = db.prepare(`DELETE FROM check_runs WHERE repo = ? AND key = ? AND (completed_at < ? OR run_id NOT IN (SELECT run_id FROM check_runs WHERE repo = ? AND key = ? ORDER BY completed_at DESC LIMIT ?))`);
  let added = 0;
  db.transaction(() => {
    const keys = new Set<string>();
    for (const { c, s } of rows) {
      const k = keyOf(c);
      added += ins.run(repo, k, runIdOf(c), pr, sha, s.conclusion, s.started, s.completed, s.completed - s.started, attemptOf(c)).changes;
      keys.add(k);
    }
    if (added) for (const k of keys) prune.run(repo, k, now - RUN_DAYS * 86_400_000, repo, k, RUNS_PER_KEY);
  })();
  return added;
}

/**
 * Put `usual` on every check that has a history. The run being read is left out
 * of its own baseline, so a slow run cannot excuse itself.
 */
export function annotateUsual(repo: string, all: PrCheck[]): void {
  if (!all.length) return;
  const rows = db.prepare(
    `SELECT key, run_id, ms FROM (SELECT key, run_id, ms, ROW_NUMBER() OVER (PARTITION BY key ORDER BY completed_at DESC) AS rn
       FROM check_runs WHERE repo = ? AND conclusion = 'success') WHERE rn <= ?`,
  ).all(repo, BASELINE_RUNS + 1) as { key: string; run_id: string; ms: number }[];
  const by = new Map<string, { run_id: string; ms: number }[]>();
  for (const r of rows) (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push(r);
  for (const c of all) {
    const hist = by.get(keyOf(c));
    if (!hist) continue;
    const id = runIdOf(c);
    const usual = baselineStats(hist.filter((h) => h.run_id !== id).map((h) => h.ms));
    if (usual) c.usual = usual;
  }
}

/** One read: feed the history, then say what is usual. */
export function learnFromRead(repo: string, pr: number | null, sha: string, all: PrCheck[]): void {
  try {
    recordRuns(repo, pr, sha, all);
    annotateUsual(repo, all);
  } catch { /* a history that cannot be written must never break a checks read */ }
}

/** Per check key: count, median, p90, failure rate, 14-day trend, same-commit flips. */
export function repoMetrics(repo: string, now = Date.now()): CheckMetric[] {
  const rows = db.prepare(`SELECT key, conclusion, ms, completed_at, head_sha, pr FROM check_runs WHERE repo = ? ORDER BY key`).all(repo) as { key: string; conclusion: StoredRun["conclusion"]; ms: number; completed_at: number; head_sha: string; pr: number | null }[];
  const by = new Map<string, StoredRun[]>();
  for (const r of rows) (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push({ conclusion: r.conclusion, ms: r.ms, completedAt: r.completed_at, sha: r.head_sha, pr: r.pr });
  return [...by.entries()].map(([key, rs]) => {
    const [workflow, name, event] = key.split("\u0001");
    return { key, workflow, name, event, aggregate: aggregateRuns(rs, now) };
  });
}
