/*
 * The "Failing tests" lens: every failing test the app has read, counted.
 *
 * `failingTests()` is a table read — no request, safe to call whenever the CI
 * view draws. `refreshFailingTests()` is the only thing that reaches GitHub: it
 * reads the failed runs it has not read yet, newest first, at most REFRESH_CAP
 * of them per call (two requests each: annotations and log, see ciFailures.ts),
 * and looks at the newest push to the default branch (one request for the run,
 * one for its jobs when it failed). It runs when somebody asks, never on a timer.
 *
 * Where the failed runs come from: the check runs the app recorded as Checks
 * tabs loaded (check_runs). A repository only learns from pull requests somebody
 * opened here, and the lens says how many failed runs that is and how many it has
 * read, so a short list is never mistaken for a short history.
 *
 * Ceiling: a test that fails in a run the app never recorded is not counted, and
 * "red on main" only looks at the newest push — one older push that failed and
 * was followed by a green one says nothing now, on purpose.
 */
import { db } from "./db.ts";
import { readCheckFailures, jobContext, passedOnRetry, seenSignatures, FAILURE_RETENTION_DAYS, type FailureSources } from "./ciFailures.ts";
import { signatureVerdict, LENS_REFRESH_CAP, type Seen } from "../../shared/failureVerdict.ts";
import type { CheckFailures, FailingTestRow, FailingTests } from "../../shared/types.ts";

/** Failed runs one refresh reads. Each is two requests, so a refresh is at most 2 × this plus the main run's. */
export const REFRESH_CAP = LENS_REFRESH_CAP;
const DAY = 86_400_000;

const jobIdOfRun = (runId: string) => /\/job\/(\d+)/.exec(runId)?.[1] ?? null;

/** Failed jobs the app recorded in the retention window, newest first, as job ids. */
function failedJobs(repo: string, now: number): { job: string; at: number }[] {
  const rows = db.prepare(`SELECT run_id, completed_at FROM check_runs WHERE repo = ? AND conclusion = 'failure' AND completed_at >= ? ORDER BY completed_at DESC`)
    .all(repo, now - FAILURE_RETENTION_DAYS * DAY) as { run_id: string; completed_at: number }[];
  const out: { job: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) { const job = jobIdOfRun(r.run_id); if (job && !seen.has(job)) { seen.add(job); out.push({ job, at: r.completed_at }); } }
  return out;
}

const isRead = (repo: string, job: string) => !!db.prepare(`SELECT 1 FROM ci_failure_reads WHERE repo = ? AND job_id = ?`).get(repo, job);

/** The rows, from what is already kept. Pure table reads. */
export function failingTests(repo: string, now = Date.now()): FailingTests {
  const items = db.prepare(`SELECT i.signature, i.title, i.kind, i.job_id, r.at FROM ci_failure_items i JOIN ci_failure_reads r ON r.repo = i.repo AND r.job_id = i.job_id AND r.attempt = i.attempt WHERE i.repo = ? ORDER BY r.at DESC`)
    .all(repo) as { signature: string; title: string; kind: string; job_id: string; at: number }[];
  const by = new Map<string, typeof items>();
  for (const it of items) (by.get(it.signature) ?? by.set(it.signature, []).get(it.signature)!).push(it);

  const rows: FailingTestRow[] = [];
  for (const [signature, list] of by) {
    const jobs = [...new Set(list.map((l) => l.job_id))];
    const ctxs = jobs.map((j) => ({ job: j, ctx: jobContext(repo, j), at: list.find((l) => l.job_id === j)!.at }));
    const seen: Seen[] = seenSignatures(repo, [signature]);
    const times = ctxs.map((c) => c.ctx?.completed || c.at);
    const checks = ctxs.map((c) => c.ctx?.name).filter((n): n is string => !!n);
    rows.push({
      title: list[0]!.title,
      gist: signature.includes(" :: ") ? signature.slice(signature.indexOf(" :: ") + 4).replace(/^(error|E|AssertionError):?\s+/i, "") : "",
      check: checks[0] ?? "",
      runs: jobs.length,
      prs: new Set(seen.map((s) => s.pr).filter((n) => n != null)).size,
      firstSeen: Math.min(...times),
      lastSeen: Math.max(...times),
      verdict: signatureVerdict(seen, { flaky: jobs.some((j) => passedOnRetry(repo, j)), weak: list[0]!.kind === "step" }),
    });
  }
  const rank = { main: 0, flaky: 1, prs: 2, "this-pr": 3, once: 4, others: 2 } as const;
  rows.sort((a, b) => rank[a.verdict.kind] - rank[b.verdict.kind] || b.runs - a.runs || b.lastSeen - a.lastSeen);

  const failed = failedJobs(repo, now);
  return { ok: true, rows, failedRuns: failed.length, readRuns: failed.filter((f) => isRead(repo, f.job)).length };
}

// ── the refresh ───────────────────────────────────────────────────────────
export interface MainJob { id: string; name: string; at: number; step?: string }
export interface MainRun { id: string; sha: string; branch: string; conclusion: string | null; at: number }
export interface LensSources {
  /** The newest finished push to the default branch. `branch` is the name already known, which saves asking for it. */
  newestMainRun(branch?: string): Promise<{ ok: true; run: MainRun | null; requests: number } | { ok: false; error: string; requests: number }>;
  /** The jobs of that run that failed: asked only for a failed run the app has not listed before. */
  mainJobs(runId: string): Promise<{ ok: true; jobs: MainJob[]; requests: number } | { ok: false; error: string; requests: number }>;
  /** What reading one job costs is the sources of ciFailures.ts; here it is just "read it". */
  readJob(job: string, step?: string): Promise<CheckFailures>;
}

/**
 * Look at the newest main push, then read up to REFRESH_CAP unread failed runs:
 * main's failed jobs first (they decide "red on main"), then the newest pull
 * request ones. Stops at the first budget answer and says what it did.
 */
export async function refreshFailingTests(repo: string, src: LensSources, now = Date.now()): Promise<FailingTests> {
  let requests = 0, read = 0, main: "red" | "green" | "unknown" = "unknown";
  let error: string | undefined;
  const budget = () => read < REFRESH_CAP;
  const note = (r: CheckFailures) => { if (r.ok) requests += r.requests; else { requests += r.requests; error = r.kind === "budget" ? "GitHub's hourly budget is used up" : r.error; } return r.ok; };

  const known = db.prepare(`SELECT branch, run_id FROM ci_main_run WHERE repo = ?`).get(repo) as { branch: string; run_id: string } | null;
  const m = await src.newestMainRun(known?.branch);
  requests += m.requests;
  if (!m.ok) error = m.error;
  else if (m.run) {
    const run = m.run;
    const red = run.conclusion === "failure";
    main = red ? "red" : run.conclusion === "success" ? "green" : "unknown";
    let jobs: MainJob[] = [];
    if (red && known?.run_id === run.id) {
      // Listed on an earlier refresh: the jobs of a finished run do not change.
      jobs = (db.prepare(`SELECT job_id AS id, name, completed_at AS at FROM ci_main_jobs WHERE repo = ? AND run_id = ?`).all(repo, run.id) as MainJob[]);
    } else if (red) {
      const j = await src.mainJobs(run.id);
      requests += j.requests;
      if (j.ok) jobs = j.jobs; else error = j.error;
    }
    if (!error || !red) {
      db.transaction(() => {
        db.prepare(`INSERT OR REPLACE INTO ci_main_run (repo, branch, run_id, sha, conclusion, at) VALUES (?,?,?,?,?,?)`).run(repo, run.branch, run.id, run.sha, run.conclusion ?? "", now);
        const ins = db.prepare(`INSERT OR REPLACE INTO ci_main_jobs (repo, job_id, run_id, name, completed_at) VALUES (?,?,?,?,?)`);
        for (const j of jobs) ins.run(repo, j.id, run.id, j.name, j.at);
      })();
    }
    if (red && !error) {
      for (const j of jobs) {
        if (!budget() || error) break;
        if (isRead(repo, j.id)) continue;
        if (!note(await src.readJob(j.id, j.step))) break;
        read++;
      }
    }
  }
  const todo = failedJobs(repo, now).filter((f) => !isRead(repo, f.job));
  for (const f of todo) {
    if (!budget() || error) break;
    if (!note(await src.readJob(f.job))) break;
    read++;
  }
  const after = failingTests(repo, now);
  const pending = failedJobs(repo, now).filter((f) => !isRead(repo, f.job)).length;
  return { ...after, refresh: { read, cap: REFRESH_CAP, pending, requests, main, ...(error ? { error } : {}) } };
}
