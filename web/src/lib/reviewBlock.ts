// The "Finish your review" block as decisions rather than markup: what the one
// Submit button says, why it is dead, how far through the files you are, and
// how a queued-comment list behaves when it is 200 long. There is no renderer
// in the tests, so each answer lives here to be asserted on.

export type Verdict = "approve" | "request_changes" | "comment";

export const VERDICTS: Record<Verdict, { label: string; sentence: string }> = {
  approve: { label: "Approve", sentence: "Mark the pull request approved. A summary is optional." },
  request_changes: { label: "Request changes", sentence: "Block the merge until the changes land. Needs a summary or a line comment." },
  comment: { label: "Comment", sentence: "Leave feedback without approving or blocking." },
};

/** The Submit button names the verdict, so the label is the confirmation. */
export function submitLabel(verb: Verdict): string {
  return VERDICTS[verb].label;
}

/**
 * Why Submit is dead, or null when it is live. Only an approval may go out
 * empty; GitHub rejects the other two without a body or a line comment.
 * `held` is a review already drafted on GitHub: its comments count too.
 */
export function submitBlocked(i: { verb: Verdict; body: string; queued: number; held?: number; held_by_agent?: boolean }): string | null {
  if (i.held_by_agent) return "An agent filled this in: read it first";
  if (i.verb === "approve") return null;
  if (i.body.trim() || i.queued > 0 || (i.held ?? 0) > 0) return null;
  return `Add a summary to ${i.verb === "request_changes" ? "request changes" : "comment"}`;
}

export interface Progress { seen: number; total: number; pct: number; done: boolean }

/** Files viewed, clamped: a stale `seen` after a force-push may exceed the total. */
export function viewedProgress(seen: number, total: number): Progress {
  const t = Math.max(0, Math.floor(total));
  const s = Math.min(Math.max(0, Math.floor(seen)), t);
  return { seen: s, total: t, pct: t === 0 ? 0 : Math.round((s / t) * 100), done: t > 0 && s === t };
}

export function queueSummary(n: number): string {
  return n === 0 ? "No line comments yet" : `${n} line comment${n === 1 ? "" : "s"} queued`;
}

/** Summary box rows grow with the text up to a cap, then scroll inside. */
export function summaryRows(body: string, min = 3, max = 14): number {
  const lines = body.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 110)), 0);
  return Math.min(max, Math.max(min, lines));
}
