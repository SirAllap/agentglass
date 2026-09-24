/**
 * The arithmetic of agx-bench, kept apart from anything that needs a browser
 * so it can be tested on its own.
 */

/** Tokens are estimated, not counted: bytes / 3.5. It is the ratio the
 *  research behind this benchmark used for JSON-heavy tool output, and the
 *  point is comparing arms against each other, where a constant factor
 *  cancels. It is not a tokenizer and says so in every report. */
export const BYTES_PER_TOKEN = 3.5;
export const TOKEN_ESTIMATOR = `tokens ≈ bytes / ${BYTES_PER_TOKEN}`;

export const tokensOf = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN);

/**
 * The q-th percentile (0..100) by linear interpolation between closest ranks —
 * the definition numpy and most spreadsheets use by default, so a number here
 * can be checked by hand. An empty list has no percentile: NaN, never 0,
 * because 0 ms reads as "instant" in a table.
 */
export function percentile(values: readonly number[], q: number): number {
  if (!values.length) return NaN;
  if (q < 0 || q > 100) throw new RangeError(`percentile ${q} is outside 0..100`);
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * (q / 100);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (values: readonly number[]) => percentile(values, 50);

/** One CLI call, as the agent would have paid for it. */
export type Call = {
  verb: string;
  argv: string[];
  ms: number;
  exit: number;
  /** What came back on stdout and stderr: both land in an agent's context. */
  stdoutBytes: number;
  stderrBytes: number;
};

/** One arm of one task, run once. */
export type Run = {
  task: string;
  family: string;
  arm: string;
  rep: number;
  ok: boolean;
  /** Why it failed: the grader's reason, or the error the arm threw. */
  error?: string;
  wallMs: number;
  steps: number;
  bytes: number;
  stdoutBytes: number;
  tokens: number;
  /** Changes made to the fixture outside the browser (the dev loop's "edit"). */
  edits: number;
  calls: Call[];
};

export type TaskSummary = {
  task: string;
  family: string;
  arm: string;
  n: number;
  successes: number;
  medianWallMs: number;
  medianSteps: number;
  medianBytes: number;
  medianTokens: number;
};

export type VerbSummary = { arm: string; verb: string; n: number; p50: number; p95: number };

export type ArmSummary = {
  arm: string;
  tasks: number;
  runs: number;
  successes: number;
  /** Sum over tasks of each task's median — "one pass over the suite". */
  wallMs: number;
  steps: number;
  bytes: number;
  tokens: number;
  /** The headline metric: tokens spent per successful task, over every run. */
  tokensPerSuccess: number;
};

export function runFromCalls(
  base: Omit<Run, "steps" | "bytes" | "stdoutBytes" | "tokens" | "calls">,
  calls: Call[],
): Run {
  const bytes = calls.reduce((n, c) => n + c.stdoutBytes + c.stderrBytes, 0);
  return {
    ...base,
    steps: calls.length,
    bytes,
    stdoutBytes: calls.reduce((n, c) => n + c.stdoutBytes, 0),
    tokens: tokensOf(bytes),
    calls,
  };
}

const key = (...parts: string[]) => parts.join("\u0000");

function groupBy<T>(xs: readonly T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const g = m.get(k(x));
    if (g) g.push(x);
    else m.set(k(x), [x]);
  }
  return m;
}

export function summarizeTasks(runs: readonly Run[]): TaskSummary[] {
  return [...groupBy(runs, (r) => key(r.task, r.arm)).values()].map((g) => ({
    task: g[0].task,
    family: g[0].family,
    arm: g[0].arm,
    n: g.length,
    successes: g.filter((r) => r.ok).length,
    medianWallMs: median(g.map((r) => r.wallMs)),
    medianSteps: median(g.map((r) => r.steps)),
    medianBytes: median(g.map((r) => r.bytes)),
    medianTokens: median(g.map((r) => r.tokens)),
  }));
}

export function summarizeVerbs(runs: readonly Run[]): VerbSummary[] {
  const calls = runs.flatMap((r) => r.calls.map((c) => ({ arm: r.arm, ...c })));
  return [...groupBy(calls, (c) => key(c.arm, c.verb)).values()]
    .map((g) => ({
      arm: g[0].arm,
      verb: g[0].verb,
      n: g.length,
      p50: percentile(g.map((c) => c.ms), 50),
      p95: percentile(g.map((c) => c.ms), 95),
    }))
    .sort((a, b) => a.arm.localeCompare(b.arm) || b.n - a.n || a.verb.localeCompare(b.verb));
}

export function summarizeArms(runs: readonly Run[]): ArmSummary[] {
  const tasks = summarizeTasks(runs);
  return [...groupBy(runs, (r) => r.arm).values()].map((g) => {
    const t = tasks.filter((s) => s.arm === g[0].arm);
    const successes = g.filter((r) => r.ok).length;
    const sum = (f: (s: TaskSummary) => number) => t.reduce((n, s) => n + f(s), 0);
    return {
      arm: g[0].arm,
      tasks: t.length,
      runs: g.length,
      successes,
      wallMs: sum((s) => s.medianWallMs),
      steps: sum((s) => s.medianSteps),
      bytes: sum((s) => s.medianBytes),
      tokens: sum((s) => s.medianTokens),
      tokensPerSuccess: successes ? g.reduce((n, r) => n + r.tokens, 0) / successes : NaN,
    };
  });
}
