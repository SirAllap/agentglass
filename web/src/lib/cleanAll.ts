/*
 * "Clean up all" in the Closed tab: the same per-PR cleanup the card's button runs (plan, then POST /cleanup/run with
 * that plan's id and the dialog's default selection), one pull request after another. Serial on purpose: the engine
 * answers once per run and two runs of one repository at once race the same worktrees. A plan a safety block refuses is
 * not run here; it is listed with the reason the plan gave, and the card's own button still opens the review dialog for
 * it. A pull request closed without merging runs the way its dialog opens: branches and stashes stay unticked, and the
 * run carries the confirmation the bulk dialog asked for. Ceiling: the pull requests counted are the cards whose
 * inventory was read, which is the ones loaded so far; "Load more" brings more into the count.
 */
import { humanSize } from "../../../shared/dockerSize.ts";
import { api } from "./api.ts";
import { beginRun, endRun } from "./cleanupEvents.ts";
import { blockViews, defaultOff, excludeOf, plural, type Report } from "./cleanupPr.ts";
import type { LeftoverState } from "./leftovers.ts";

export interface CleanTarget { pr: number; items: number; bytes: number; /** Closed without merging: its branches and stashes stay, and the dialog's confirmation is what lets it run at all. */ closedUnmerged: boolean }
export interface CleanFailure { pr: number; why: string }
export interface CleanSummary { done: number; freed: number; failed: CleanFailure[] }

/** The finished pull requests whose inventory says something is left, in the order given. */
export function cleanTargets(rows: readonly { number: number; state: string }[], stateOf: (pr: number, state: string) => LeftoverState | undefined): CleanTarget[] {
  const out: CleanTarget[] = [], seen = new Set<number>();
  for (const r of rows) {
    if (r.state === "OPEN" || seen.has(r.number)) continue; // a number twice must not run twice
    seen.add(r.number);
    const s = stateOf(r.number, r.state);
    if (s?.kind === "some" && s.items >= 1) out.push({ pr: r.number, items: s.items, bytes: s.bytes, closedUnmerged: r.state === "CLOSED" });
  }
  return out;
}

export const totalsOf = (t: readonly CleanTarget[]): { prs: number; items: number; bytes: number } =>
  ({ prs: t.length, items: t.reduce((n, x) => n + x.items, 0), bytes: t.reduce((n, x) => n + x.bytes, 0) });

export const confirmBody = (t: readonly CleanTarget[]): string => {
  const x = totalsOf(t), closed = t.filter((c) => c.closedUnmerged).length;
  return `${plural(x.prs, "pull request")} · ${plural(x.items, "item")}${x.bytes > 0 ? ` · ${humanSize(x.bytes)}` : ""}\n`
    + "Each one is cleaned the way its own Clean up button does it, one after another. Nothing on GitHub changes. "
    + (closed ? `${plural(closed, "pull request")} ${closed === 1 ? "was" : "were"} closed without merging, so ${closed === 1 ? "its branch and stashes" : "their branches and stashes"} stay. ` : "")
    + "One that a safety block refuses is skipped and listed at the end.";
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
      const block = blockViews(r.plan)[0];
      if (block) { sum.failed.push({ pr, why: `Blocked: ${block.title}.` }); continue; }
      if (!beginRun(repo, pr)) { sum.failed.push({ pr, why: "Already being cleaned up." }); continue; }
      began = true;
      /* The dialog's own default selection: a pull request closed without merging keeps its branches and stashes, and the
         person's "Clean up all" is the confirmation its run needs. */
      const out = await api.cleanupRun(repo, pr, r.plan.id, excludeOf(r.plan, defaultOff(r.plan)), r.plan.notMerged);
      if (out.items) { report = out as Report; sum.freed += report.freedBytes; if (report.failed > 0) sum.failed.push({ pr, why: `${plural(report.failed, "item")} failed.` }); else sum.done++; }
      else sum.failed.push({ pr, why: out.error ?? "The cleanup was refused." });
    } catch (e) { sum.failed.push({ pr, why: String((e as Error).message ?? e) }); }
    finally { if (began) endRun(repo, pr, report); } // the cards refresh on this, as for any run
  }
  return sum;
}
