/*
 * The "Failing tests" lens, as decisions: what it says while it reads, what a
 * refresh cost, how a row is worded. No React, so each is tested as a function.
 */
import type { FailingTestRow, FailingTests } from "../../../shared/types.ts";
import { verdictLabel, type TestVerdict } from "../../../shared/failureVerdict.ts";
import { plural } from "./checkFailures.ts";

type Refresh = NonNullable<FailingTests["refresh"]>;

/** Requests one refresh can make at most: the run, its jobs, the branch name, and annotations + log for each run read. */
export const maxRequests = (cap: number) => 3 + 2 * cap;

/** Said before the first press, so what a refresh may cost is known first. */
export function budgetLine(cap: number): string {
  return `A refresh reads at most ${plural(cap, "failed run")}: up to ${maxRequests(cap)} GitHub requests, only when you press it.`;
}

/** What the lens is doing while it reads. The numbers are the ones it will act on. */
export function readingLine(t: Pick<FailingTests, "failedRuns" | "readRuns">, cap: number): string {
  const toFetch = Math.min(Math.max(t.failedRuns - t.readRuns, 0), cap);
  return `Reading ${plural(t.failedRuns, "failed run")} · ${t.readRuns} already kept, ${toFetch} to fetch`;
}

/** What a refresh did, in one line: reads, what is left, what it cost. */
export function refreshLine(r: Refresh): string {
  const parts = [r.read ? `Read ${plural(r.read, "failed run")}` : "Nothing new to read"];
  if (r.pending) parts.push(`${r.pending} left for the next refresh`);
  parts.push(plural(r.requests, "request"));
  if (r.main !== "unknown") parts.push(`the newest push to the default branch is ${r.main === "red" ? "red" : "green"}`);
  return parts.join(" · ") + (r.error ? ` — stopped: ${r.error}` : "");
}

/** The coverage of the list, always stated: a short list is not a short history. */
export function coverageLine(t: Pick<FailingTests, "failedRuns" | "readRuns">): string {
  return t.failedRuns === 0
    ? "No failed runs recorded in the last 90 days."
    : `Counted from ${t.readRuns} of ${plural(t.failedRuns, "failed run")} recorded in the last 90 days.`;
}

export function dateWords(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return "today";
  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

export type Tone = "bad" | "warn" | "info" | "quiet";
/** Colour is a second signal: every verdict also has its words. */
export function verdictTone(v: TestVerdict): Tone {
  return v.kind === "main" ? "bad" : v.kind === "flaky" ? "warn" : v.kind === "this-pr" ? "info" : "quiet";
}

export const rowVerdict = (r: FailingTestRow) => verdictLabel(r.verdict);

export function matchesTest(r: FailingTestRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${r.title} ${r.gist} ${r.check} ${verdictLabel(r.verdict)}`.toLowerCase().includes(q);
}

/** The footnote that says what each verdict saw. Kept next to the table so nobody reads a word for more than it claims. */
export const VERDICT_NOTE = "Red on main: the same failure on the newest push to the default branch. Flaky test: it failed and passed on the same commit. Failed on N PRs: it failed on several pull requests. This PR only: nothing else read shows it. Seen once: a step's exit code, too little to say.";
