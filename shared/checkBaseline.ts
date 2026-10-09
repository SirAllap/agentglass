// How long a check usually takes, and whether this run is normal.
//
// Measured: the Checks tab painted every job of 5 minutes or more amber, and an
// eval suite that always takes ~15 minutes was amber on every pull request, so
// the colour said nothing. The only honest yardstick for a job is the same job
// on earlier runs: same workflow, same job name, same trigger.
//
// Pure, so both halves and the tests share one set of thresholds. What this
// does not do: judge a failed or cancelled run (it stops early, so "faster"
// would be a lie), or a job with fewer than MIN_SAMPLES successes behind it.

/** Same run of a job on every pull request: workflow, job name and trigger, the key the count already uses. */
export const runKey = (workflow: string | undefined, name: string, event: string | undefined): string =>
  `${workflow || ""}\u0001${name}\u0001${event || ""}`;

/** What one check usually takes: from the last BASELINE_RUNS successful runs. */
export interface CheckUsual { median: number; p90: number; n: number }

export const BASELINE_RUNS = 20;
/** Under this many successes there is no verdict: three runs are an anecdote. */
export const MIN_SAMPLES = 5;
/** A difference under this is noise, whatever the ratio: 4s against 1s is not "much slower". */
export const NOISE_MS = 15_000;

export type DurationVerdict = "usual" | "slower" | "much-slower" | "faster" | "unknown";

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = sorted(xs), m = s.length >> 1;
  // Indexes are in range: the empty case returned above.
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Nearest rank: the value 90% of runs came in at or under. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/** Median and p90 of the newest `BASELINE_RUNS` durations (newest first). Null when there are none. */
export function baselineStats(newestFirst: number[]): CheckUsual | null {
  const xs = newestFirst.filter((d) => Number.isFinite(d) && d > 0).slice(0, BASELINE_RUNS);
  return xs.length ? { median: median(xs), p90: percentile(xs, 0.9), n: xs.length } : null;
}

/** The line above which a run is slower than usual. */
export const slowLine = (u: CheckUsual): number => Math.max(u.p90, 1.5 * u.median);

/**
 * `ms` is the run's duration, or the time elapsed so far for one still going.
 * A running job can only be "slower" (it has not finished, so it cannot be
 * faster), which the tab words as "running longer than usual".
 */
export function durationVerdict(ms: number | null, usual: CheckUsual | undefined, running = false): DurationVerdict {
  if (ms == null || !usual || usual.n < MIN_SAMPLES || usual.median <= 0) return "unknown";
  const over = ms - usual.median >= NOISE_MS;
  if (over && ms > 2.5 * usual.median && !running) return "much-slower";
  if (over && ms > slowLine(usual)) return "slower";
  if (!running && usual.median - ms >= NOISE_MS && ms < 0.5 * usual.median) return "faster";
  return "usual";
}

// ---------------------------------------------------------------------------
// Aggregates over every stored run, for the metrics view to come.
// ---------------------------------------------------------------------------

export interface StoredRun { conclusion: "success" | "failure" | "cancelled"; ms: number; completedAt: number }

export interface CheckAggregate {
  runs: number;
  /** Successful runs: what median and p90 stand on, so the view can refuse a verdict under MIN_SAMPLES. */
  successes: number;
  /** The newest run that was not cancelled, the one the view holds up against the rest. Null with none. */
  latest: { ms: number; conclusion: "success" | "failure"; completedAt: number } | null;
  /** Successful runs only, like the baseline. Null with none. */
  median: number | null;
  p90: number | null;
  /** Failures over successes plus failures: a cancelled run says nothing about the job. Null with neither. */
  failureRate: number | null;
  /** One bucket per day over the last `days`, oldest first; `median` is null on a day with no success. */
  trend: { day: string; runs: number; median: number | null }[];
}

export function aggregateRuns(rows: StoredRun[], now: number, days = 14): CheckAggregate {
  const ok = rows.filter((r) => r.conclusion === "success").map((r) => r.ms);
  const bad = rows.filter((r) => r.conclusion === "failure").length;
  const dayMs = 86_400_000;
  const today = Math.floor(now / dayMs);
  const trend = Array.from({ length: days }, (_, i) => {
    const d = today - (days - 1 - i);
    const inDay = rows.filter((r) => Math.floor(r.completedAt / dayMs) === d);
    const s = inDay.filter((r) => r.conclusion === "success").map((r) => r.ms);
    return { day: new Date(d * dayMs).toISOString().slice(0, 10), runs: inDay.length, median: s.length ? median(s) : null };
  });
  const newest = rows.filter((r) => r.conclusion !== "cancelled").reduce<StoredRun | null>((a, r) => (!a || r.completedAt > a.completedAt ? r : a), null);
  return {
    runs: rows.length,
    successes: ok.length,
    latest: newest ? { ms: newest.ms, conclusion: newest.conclusion as "success" | "failure", completedAt: newest.completedAt } : null,
    median: ok.length ? median(ok) : null,
    p90: ok.length ? percentile(ok, 0.9) : null,
    failureRate: ok.length + bad ? bad / (ok.length + bad) : null,
    trend,
  };
}

/** One check of the repository, as `/prs/check-metrics` answers it. */
export interface CheckMetric { key: string; workflow: string; name: string; event: string; aggregate: CheckAggregate }
