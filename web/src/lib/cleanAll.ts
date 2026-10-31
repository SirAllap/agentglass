/*
 * "Clean up all" in the Closed tab: the same per-PR cleanup the card's button runs (plan, then POST /cleanup/run with
 * that plan's id and the dialog's default selection), one pull request after another. Serial on purpose: the engine
 * answers once per run and two runs of one repository at once race the same worktrees. A plan that needs a person's
 * look (a block, or a pull request closed without merging) is not run here; it is listed, and the card's own button
 * still opens the review dialog for it. Ceiling: the pull requests counted are the cards whose inventory was read,
 * which is the ones loaded so far; "Load more" brings more into the count.
 */
import { humanSize } from "../../../shared/dockerSize.ts";
import { api } from "./api.ts";
import { beginRun, endRun } from "./cleanupEvents.ts";
import { defaultOff, excludeOf, needsLook, plural, type Report } from "./cleanupPr.ts";
import type { LeftoverState } from "./leftovers.ts";

export interface CleanTarget { pr: number; items: number; bytes: number }
export interface CleanFailure { pr: number; why: string }
export interface CleanSummary { done: number; freed: number; failed: CleanFailure[] }

/** The finished pull requests whose inventory says something is left, in the order given. */
export function cleanTargets(rows: readonly { number: number; state: string }[], stateOf: (pr: number, state: string) => LeftoverState | undefined): CleanTarget[] {
  const out: CleanTarget[] = [], seen = new Set<number>();
  for (const r of rows) {
    if (r.state === "OPEN" || seen.has(r.number)) continue; // a number twice must not run twice
    seen.add(r.number);
    const s = stateOf(r.number, r.state);
    if (s?.kind === "some" && s.items >= 1) out.push({ pr: r.number, items: s.items, bytes: s.bytes });
  }
  return out;
}

export const totalsOf = (t: readonly CleanTarget[]): { prs: number; items: number; bytes: number } =>
  ({ prs: t.length, items: t.reduce((n, x) => n + x.items, 0), bytes: t.reduce((n, x) => n + x.bytes, 0) });

export const confirmBody = (t: readonly CleanTarget[]): string => {
  const x = totalsOf(t);
  return `${plural(x.prs, "pull request")} · ${plural(x.items, "item")}${x.bytes > 0 ? ` · ${humanSize(x.bytes)}` : ""}\n`
    + "Each one is cleaned the way its own Clean up button does it, one after another. Nothing on GitHub changes. "
    + "A pull request that needs a look (a block, or closed without merging) is skipped and listed at the end.";
};

export const progressWord = (at: number, of: number): string => `Cleaning ${at} of ${of}…`;

export const summaryWord = (s: CleanSummary): string =>
  [`Cleaned ${plural(s.done, "pull request")}`, ...(s.freed > 0 ? [`${humanSize(s.freed)} freed`] : []), ...(s.failed.length ? [`${s.failed.length} not cleaned`] : [])].join(" · ");

/** Runs them one by one. A failure is recorded and the next one still runs. `onStep(n)` is called before the n-th (1-based). */
export async function cleanAll(repo: string, prs: readonly number[], onStep: (n: number) => void = () => {}): Promise<CleanSummary> {
  const sum: CleanSummary = { done: 0, freed: 0, failed: [] };
  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]!;
    onStep(i + 1);
    let report: Report | undefined;
    let began = false;
    try {
      const r = await api.cleanupPlan(repo, pr);
      if (!r.ok || !r.plan) { sum.failed.push({ pr, why: r.error ?? "The plan could not be read." }); continue; }
      const look = needsLook(r.plan);
      if (look === "block" || look === "not-merged") { sum.failed.push({ pr, why: look === "block" ? "Blocked: open it to see why." : "Closed without merging: open it to review." }); continue; }
      if (!beginRun(repo, pr)) { sum.failed.push({ pr, why: "Already being cleaned up." }); continue; }
      began = true;
      const out = await api.cleanupRun(repo, pr, r.plan.id, excludeOf(r.plan, defaultOff(r.plan)), false);
      if (out.items) { report = out as Report; sum.freed += report.freedBytes; if (report.failed > 0) sum.failed.push({ pr, why: `${plural(report.failed, "item")} failed.` }); else sum.done++; }
      else sum.failed.push({ pr, why: out.error ?? "The cleanup was refused." });
    } catch (e) { sum.failed.push({ pr, why: String((e as Error).message ?? e) }); }
    finally { if (began) endRun(repo, pr, report); } // the cards refresh on this, as for any run
  }
  return sum;
}
