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
import type { PrCheck, PrCheckJob, PrCheckRollup } from "../../../shared/types.ts";

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

/**
 * How long a job ran, or has been running: the second line of its row.
 *
 * "failed" alone does not say whether it fell over in the install step or
 * after twelve minutes of tests, and the difference is most of what somebody
 * needs to guess where in the log to look.
 */
export function ranFor(job: PrCheckJob, now: number): string {
  const span = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const started = job.startedAt ? Date.parse(job.startedAt) : NaN;
  const ended = job.completedAt ? Date.parse(job.completedAt) : NaN;
  const { standing, word } = standingOf(job);
  if (standing === "running") return Number.isFinite(started) ? `Started ${span(now - started)} ago` : word[0]!.toUpperCase() + word.slice(1);
  // GitHub's conclusion is a noun ("failure"); the row reads as a sentence.
  const said = word === "failure" ? "failed" : word;
  const label = said[0]!.toUpperCase() + said.slice(1);
  return Number.isFinite(started) && Number.isFinite(ended) ? `${label} after ${span(ended - started)}` : label;
}

/** A log line worth tinting: where it says it failed. Conservative on
 *  purpose — a tint on every line containing "error" in a path is noise. */
export function looksFailed(line: string): boolean {
  return /(^|\s)(✗|✕|×|FAIL\b|FAILED\b)|\b[Ee]rror:|##\[error\]|exited with code [1-9]|^\s*(Expected|Received):/.test(line);
}

/**
 * GitHub Actions' own log, folded to what a phone can read.
 *
 * Every line arrives stamped with an ISO timestamp — about 28 characters,
 * half the width of this screen before the log itself starts — and each step
 * is wrapped in `##[group]` / `##[endgroup]`, GitHub's own markers for a
 * collapsible section on its own log viewer, which this screen has no
 * equivalent chrome for and drew as two more lines of noise instead. The web
 * panel already folds on the same markers (PrPanel.tsx's `JobLog`); this is
 * the same rule where there is no renderer to fold INTO steps, so the group
 * marker becomes its title line and the close marker is dropped rather than
 * built into a collapsible tree.
 *
 * `##[error]` is left exactly as GitHub wrote it — `looksFailed` matches that
 * marker to tint the row, and stripping it here would blind the one styling
 * this was asked to keep.
 */
export function foldJobLog(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "");
    const group = line.match(/^##\[group\](.*)$/);
    if (group) { out.push(group[1] || "step"); continue; }
    if (/^##\[endgroup\]/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** How long to wait before asking for the jobs again: only while one is still
 *  running, and never otherwise. A finished run cannot change, so polling it is
 *  requests spent on a screen that is not going to move. */
export const JOBS_POLL_MS = 15_000;
export function nextJobsPoll(jobs: readonly PrCheckJob[] | null): number | null {
  return jobs?.some((j) => standingOf(j).standing === "running") ? JOBS_POLL_MS : null;
}

/** Did the checks move between two reads? The pull request's screen asks for
 *  the rollup while something runs — one GraphQL call, where re-reading the
 *  whole detail is two — and only pays for the detail when this says yes. */
export function checksMoved(a: PrCheckRollup, b: PrCheckRollup): boolean {
  return a.total !== b.total || a.success !== b.success || a.failure !== b.failure
    || a.pending !== b.pending || a.skipped !== b.skipped;
}

/** The same question for the pull request's own screen. */
export const DETAIL_POLL_MS = 30_000;
export function nextDetailPoll(pending: number | undefined): number | null {
  return pending && pending > 0 ? DETAIL_POLL_MS : null;
}

/** One square of a run, as the mock draws it (screens 32, 34 and 41). */
export type RunSquare = "fail" | "run" | "pass" | "skip";

/**
 * The run as squares: one per check, the red ones first.
 *
 * A run of forty-nine cannot be forty-nine squares on a phone, so the strip is
 * a sample with a stated size — ten, and the row beside it says how many the
 * ten stand for. Failures come first for the same reason `byUrgency` puts them
 * first: the square somebody is looking for is the red one, and a sample taken
 * in GitHub's order would put it anywhere.
 */
export function runSquares(c: PrCheckRollup, cap = 10): RunSquare[] {
  const out: RunSquare[] = [];
  const fill = (n: number, square: RunSquare): void => {
    for (let i = 0; i < n && out.length < cap; i++) out.push(square);
  };
  fill(c.failure, "fail");
  fill(c.pending, "run");
  fill(c.skipped, "skip");
  fill(c.success, "pass");
  return out;
}

/**
 * The run in one line: "48 of 49 passed · 1 running".
 *
 * "48 of 49" and not "1 failing", because the denominator is the fact a reader
 * cannot get anywhere else on the screen: a run of three with one red is a
 * different morning from a run of forty-nine with one red.
 */
export function runLine(c: PrCheckRollup): string {
  if (!c.total) return "No checks on this pull request";
  const parts = [`${c.success} of ${c.total} passed`];
  if (c.failure) parts.push(`${c.failure} failed`);
  if (c.pending) parts.push(`${c.pending} running`);
  if (!c.failure && !c.pending && c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.join(" · ");
}

/** "2 of 3 jobs passed": the count a reader needs before the sentence that
 *  follows it, and the same denominator `runLine` keeps. Skipped checks are
 *  not failures, so they count here as they do on the board's bar. */
export function jobsPassedLine(c: PrCheckRollup): string {
  if (!c.total) return "No checks";
  return `${Math.max(0, c.total - c.failure - c.pending)} of ${c.total} jobs passed`;
}

/**
 * The check that is still going, named with how long it has been going:
 * "server tests · 4 min in".
 *
 * "2 of 3 passed" does not say which one you are waiting for, and on a phone
 * that is the only reason to look at the strip. The oldest one wins: a run
 * waiting on three jobs moves forward at the speed of the slowest.
 */
export function runningCheckLine(checks: readonly PrCheck[], now: number): string | null {
  const running = checks.filter((c) => c.state === "pending");
  if (!running.length) return null;
  // A queued job has no start time yet: its name is still the thing you are
  // waiting for, so it is named without a duration rather than left out.
  const at = (c: PrCheck): number => (c.startedAt ? Date.parse(c.startedAt) : NaN);
  const timed = running.filter((c) => Number.isFinite(at(c)));
  if (!timed.length) return running[0]!.name;
  const oldest = timed.reduce((a, b) => (at(a) <= at(b) ? a : b));
  return `${oldest.name} · ${Math.max(0, Math.floor((now - at(oldest)) / 60_000))} min in`;
}

/**
 * The job list's own squares, one per job, red first.
 *
 * Different from `runSquares`, which counts CHECKS: the job list knows jobs,
 * and a screen that drew ten squares from three jobs would be inventing seven.
 * The cap is the same, and so is the order — `byUrgency`'s.
 */
export function jobSquares(jobs: readonly PrCheckJob[], cap = 10): RunSquare[] {
  const out: RunSquare[] = [];
  for (const job of byUrgency(jobs)) {
    if (out.length >= cap) break;
    const { standing } = standingOf(job);
    out.push(standing === "failed" ? "fail" : standing === "running" ? "run" : "pass");
  }
  return out;
}

/** "3 jobs · 1 running · 2 passed", the job list's quiet line. */
export function jobsLine(jobs: readonly PrCheckJob[]): string {
  if (!jobs.length) return "No jobs are attached to this pull request";
  const count = (s: JobStanding): number => jobs.filter((j) => standingOf(j).standing === s).length;
  const parts = [`${jobs.length} job${jobs.length === 1 ? "" : "s"}`];
  if (count("failed")) parts.push(`${count("failed")} failed`);
  if (count("running")) parts.push(`${count("running")} running`);
  if (count("fine")) parts.push(`${count("fine")} passed`);
  return parts.join(" · ");
}

/** One row of "What counts as green": a workflow, its checks as squares, and
 *  the one word its column says. */
export interface RunGroup {
  name: string;
  count: number;
  squares: RunSquare[];
  /** "passed", "1 running", "2 failed", "does not run". */
  word: string;
  tone: "fine" | "running" | "failed" | "none";
}

/** How many squares one workflow may draw. A job of forty checks is a strip
 *  the width of the phone and then some; the row's own count carries the rest. */
const GROUP_SQUARES = 24;

/** The run, grouped by workflow, in the order GitHub listed them.
 *
 *  `workflow` and not `name`: one workflow contributes many checks, and a row
 *  per check would be forty rows saying the same thing. A check with no
 *  workflow (an old server, a commit status) stands alone under its own name
 *  rather than disappearing into a group called "". */
export function runGroups(checks: readonly PrCheck[], cap = GROUP_SQUARES): RunGroup[] {
  const order: string[] = [];
  const groups = new Map<string, PrCheck[]>();
  for (const check of checks) {
    const name = check.workflow || check.name;
    const list = groups.get(name);
    if (list) list.push(check);
    else { groups.set(name, [check]); order.push(name); }
  }
  return order.map((name) => {
    const list = groups.get(name)!;
    const failed = list.filter((c) => c.state === "failure").length;
    const running = list.filter((c) => c.state === "pending").length;
    const skipped = list.filter((c) => c.state === "skipped").length;
    const squares = list.slice(0, cap).map((c): RunSquare =>
      c.state === "failure" ? "fail" : c.state === "pending" ? "run" : c.state === "skipped" ? "skip" : "pass");
    // A failure outranks a running job: the row is read to find what to fix,
    // and "1 running" beside a red square hides it.
    if (failed) return { name, count: list.length, squares, word: `${failed} failed`, tone: "failed" as const };
    if (running) return { name, count: list.length, squares, word: `${running} running`, tone: "running" as const };
    if (skipped === list.length) return { name, count: list.length, squares, word: "does not run", tone: "none" as const };
    return { name, count: list.length, squares, word: "passed", tone: "fine" as const };
  });
}

/** The line under the skip switch: what "green" would then mean, in checks. */
export function greenMeansLine(total: number, skipped: number): string {
  if (!total) return "No checks to count yet";
  if (!skipped) return `Green means all ${total} checks`;
  return `Green means ${total - skipped} checks, not ${total}`;
}
