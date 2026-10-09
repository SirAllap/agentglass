// The question asked before a merge (or an armed auto-merge) that skips a
// review. The decision of WHAT is skipped is shared/reviewRoster.ts `mergeGuard`;
// this is the one place that turns it into a dialog, so the two merge paths in
// the panel cannot word it differently or one of them forget it.
//
// It never remembers an answer: every press asks again, because whether
// landing ahead of somebody is fine is a fact about today's pull request.
import { guardLines, mergeGuard } from "../../../shared/reviewRoster.ts";
import type { PrReview, PrReviewer } from "../../../shared/types.ts";
import type { ConfirmSpec } from "../components/ConfirmDialog.tsx";

export async function confirmMergeGuard(
  pr: { reviews: PrReview[]; reviewers: PrReviewer[]; author?: string },
  ask: (spec: ConfirmSpec) => Promise<boolean>,
): Promise<boolean> {
  const g = mergeGuard(pr);
  if (!g) return true;
  return ask({
    title: "Merge before the review?",
    body: `${guardLines(g).map((l) => `• ${l}`).join("\n")}\n\nGitHub allows it. Merging skips ${g.pending.length ? "their review" : "a human review"}.`,
    confirmLabel: "Merge anyway",
    cancelFocus: true,
  });
}
