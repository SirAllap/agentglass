/*
 * "Offer at merge time", after the merge: the tick in the merge dialog was the
 * consent, so a plan that needs no look runs at once with the default selection
 * and the person sees one toast. Anything that needs a look (cleanupStep in
 * cleanupPr.ts), and any failure to read or run, hands back to the review
 * dialog, which says why. The decision is pure and tested; this is the wiring.
 */
import { api } from "./api.ts";
import { cleanupStep, noteOf, runningNote, type Report } from "./cleanupPr.ts";
import { beginRun, endRun, showCleanupNote } from "./cleanupEvents.ts";

export async function cleanAfterMerge(repo: string, pr: number): Promise<"dialog" | "done" | "none"> {
  try {
    const r = await api.cleanupPlan(repo, pr);
    if (!r.ok || !r.plan) return "dialog";
    const step = cleanupStep("atMerge", "merge-tick", r.plan);
    if (step !== "direct") return step === "dialog" ? "dialog" : "none";
    if (!beginRun(repo, pr)) return "none"; // already being cleaned from another view
    let report: Report | undefined;
    showCleanupNote(runningNote(r.plan)); // progress is this toast, never a window
    try {
      const out = await api.cleanupRun(repo, pr, r.plan.id, [], false);
      if (out.items) report = out as Report;
    } finally { endRun(repo, pr, report); }
    if (!report) { showCleanupNote(null); return "dialog"; }
    showCleanupNote(noteOf(r.plan, report));
    return "done";
  } catch { showCleanupNote(null); return "dialog"; }
}
