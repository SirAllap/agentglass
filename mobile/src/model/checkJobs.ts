/*
 * What a CI job's two fields add up to, and which one to read first.
 *
 * Data, not JSX, for the reason dates.ts gives: a helper that lives inside a
 * screen is a helper no test can reach, because `react-native`'s entry point
 * cannot be parsed by the test runner. Every rule below is one somebody would
 * otherwise get wrong by eye.
 *
 * ── the two fields, and why the order matters ────────────────────────────
 * GitHub reports a job as `status` plus `conclusion`, and `conclusion` is null
 * for as long as the job is running. So a running job read conclusion-first is
 * indistinguishable from one that has no verdict — and "no verdict" rendered
 * as anything other than "still going" is the screen telling somebody to go
 * and fix a job that has not finished. Status is read first, always.
 *
 * ── and why `skipped` is not a failure ───────────────────────────────────
 * A path-filtered workflow skips most of its jobs on most pull requests. They
 * are `completed` with a conclusion of `skipped`, and grouping those with the
 * red ones would report a normal pull request as twenty failures.
 */
import type { PrCheckJob } from "../../../shared/types.ts";

/** The three states a row can be in, which is fewer than GitHub's list on
 *  purpose: what a person standing up needs is red, still-going, or neither. */
export type JobStanding = "failed" | "running" | "fine";

/**
 * What this job actually is.
 *
 * `word` is what the row prints. GitHub's own vocabulary is kept — "cancelled",
 * "timed_out", "action_required" — rather than flattened to "failed", because
 * a cancelled job and a failing test are different things to do next and the
 * row has the width for the real word.
 */
export function standingOf(job: PrCheckJob): { standing: JobStanding; word: string } {
  if (job.status !== "completed") {
    // `in_progress` and `queued` are GitHub's, and the underscore is not for
    // reading. Both mean the same thing here: come back.
    return { standing: "running", word: job.status.replace(/_/g, " ") };
  }
  const c = (job.conclusion || "").toLowerCase();
  if (c === "success") return { standing: "fine", word: "passed" };
  if (c === "skipped" || c === "neutral") return { standing: "fine", word: c };
  // Includes the empty string: a completed job that reported no conclusion is
  // not a job that passed, and calling it one is the expensive direction.
  return { standing: "failed", word: c || "failed" };
}

/**
 * Failed, then running, then the rest.
 *
 * Somebody arriving on this screen came for the red one, and a workflow with
 * forty jobs puts it anywhere. Inside each band the order GitHub gave them is
 * kept, which is the order of the workflow — so the first red job is the first
 * thing that broke, and that is usually the only one worth reading.
 *
 * A copy, never in place: the caller holds the fetched array in state and
 * sorting that would be a mutation React cannot see.
 */
export function byUrgency(jobs: readonly PrCheckJob[]): PrCheckJob[] {
  const rank = (j: PrCheckJob): number => {
    const { standing } = standingOf(j);
    return standing === "failed" ? 0 : standing === "running" ? 1 : 2;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}

/**
 * The lines to open a log on.
 *
 * The tail, because a CI failure is the last thing before the process exits.
 * Opening at the top means scrolling past four hundred lines of dependency
 * resolution to reach the one line anybody wants, every time.
 *
 * Trailing blank lines go first — a log that ends in six of them would open on
 * an empty screen, which reads exactly like a log that failed to load.
 */
export function tailOf(text: string, limit: number): { lines: string[]; total: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  // A single empty string is what "".split("\n") gives, and it is not a line.
  const total = all.length === 1 && all[0] === "" ? 0 : all.length;
  if (!total) return { lines: [], total: 0 };
  return { lines: total <= limit ? all : all.slice(-limit), total };
}
