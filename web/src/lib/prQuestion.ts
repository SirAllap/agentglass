// "Can I merge?" above the tabs (mockups 05 and 06): one word, one sentence,
// and a folded form for a low window. Pure; the panel only draws what this says.
//
// The word leads the sentence so colour is never the only signal: Yes, Not yet,
// No (a conflict, which only a person fixes), Merged, Closed.

import type { Verdict } from "./prOverviewView.ts";

export type QuestionWord = "Yes" | "Not yet" | "No" | "Merged" | "Closed";

/** Below this window height the card folds to one line (mockup 06, "Long title + low window"). */
export const FOLD_BELOW_PX = 560;

export function questionWord(i: { state: "OPEN" | "MERGED" | "CLOSED"; verdict: Pick<Verdict, "tone">; conflicted: boolean }): QuestionWord {
  if (i.state === "MERGED") return "Merged";
  if (i.state === "CLOSED") return "Closed";
  if (i.conflicted) return "No";
  return i.verdict.tone === "ok" ? "Yes" : "Not yet";
}

/** The verdict with its lead swapped for the word; the sentence after it is untouched. */
export function questionVerdict(v: Verdict, word: QuestionWord): Verdict {
  return { ...v, lead: `${word}.` };
}

/** Folded only when the window is low and the person has not asked to see it. It never opens by itself. */
export function questionFolded(heightPx: number, shown: boolean): boolean {
  return heightPx > 0 && heightPx < FOLD_BELOW_PX && !shown;
}

/** The one line a folded card keeps: "Not yet · 3 checks failed · ana not looked". */
export function foldedLine(word: QuestionWord, reasons: string[], max = 2): string {
  const rest = reasons.map((r) => r.replace(/[.\s]+$/, "")).filter(Boolean).slice(0, max);
  return [word, ...rest].join(" · ");
}

export interface NowBar { green: number; running: number; failed: number; total: number; usual: string | null }

/** The NOW line of mockup 05: the run as counts, and how long the slowest unfinished job usually takes ("e2e usually 6 min"). */
export function nowBar(checks: { name: string; state: string; done: boolean; startedAt?: string; usual?: { median: number; n: number } }[]): NowBar | null {
  if (checks.length === 0) return null;
  const green = checks.filter((c) => c.done && (c.state === "success" || c.state === "skipped" || c.state === "neutral")).length;
  const failed = checks.filter((c) => c.done && c.state === "failure").length;
  const running = checks.filter((c) => !c.done).length;
  const slow = checks.filter((c) => !c.done && c.usual && c.usual.n >= 5 && c.usual.median > 0)
    .sort((a, b) => b.usual!.median - a.usual!.median)[0];
  const min = slow ? Math.max(1, Math.round(slow.usual!.median / 60_000)) : 0;
  return { green, running, failed, total: checks.length, usual: slow ? `${slow.name} usually ${min} min` : null };
}

/** Nudge belongs on a review row that waits on a named person (a reviewer or a team), not on CI and not on me. */
export function canNudge(r: { kind: string; mover: string; person?: unknown }): boolean {
  return r.kind === "review-required" && (r.mover === "reviewer" || r.mover === "team") && !!r.person;
}

/** True when a REQUIRED check is still failing or running; optional ones never hold the merge. */
export function requiredChecksOpen(checks: { required?: boolean; done: boolean; state: string }[]): boolean {
  return checks.some((c) => c.required && (!c.done || !(c.state === "success" || c.state === "skipped" || c.state === "neutral")));
}

const CHECK_OR_REVIEW = new Set(["check-failing", "check-running", "check-queued", "check-cancelled", "required-missing", "review-required", "note", "approved"]);

/** The dock may say "Merge unlocks when ..." only when nothing but checks and review stands in the way. */
export function onlyChecksAndReviewBlock(kinds: string[]): boolean {
  return kinds.every((k) => CHECK_OR_REVIEW.has(k));
}

/** The verdict keeps its own words. The dock carries the reason line, so the verdict never prints it, not even when the hero has no words (then the verdict says no reason and the dock says it once). */
export function verdictWhy(heroText: string): string {
  return heroText;
}

/** The jewel's arc: how many of the four stages are done (mockup 05, the ring around the merge icon). */
export function jewelFraction(stages: { status: string }[]): number {
  if (stages.length === 0) return 0;
  return stages.filter((s) => s.status === "done").length / stages.length;
}

/** The small caps tag on a reason row: BLOCKS when a person has to act, WAITS when only time or someone asked is missing. */
export function rowTag(mover: string): "BLOCKS" | "WAITS" | null {
  if (mover === "you" || mover === "author" || mover === "other") return "BLOCKS";
  if (mover === "ci" || mover === "wait" || mover === "reviewer" || mover === "team") return "WAITS";
  return null;
}

/** The hero's rerun button counts what the rerun really runs: distinct failed workflow runs (url holds /actions/runs/<id>), as the server's rerunFailedChecks does, required or not. No count, no number. */
export function rerunLabel(checks: { url?: string | null; state: string }[]): string {
  const ids = new Set<string>();
  for (const c of checks) {
    const m = c.state === "failure" ? (c.url ?? "").match(/\/actions\/runs\/(\d+)/) : null;
    if (m) ids.add(m[1]!);
  }
  return ids.size > 0 ? `Re-run ${ids.size} failed` : "Re-run failed";
}

/** Finished failures that are not required (optional or other CI): the hint under the stepper says how many. */
export function optionalFailedCount(checks: { required?: boolean; done: boolean; state: string }[]): number {
  return checks.filter((c) => !c.required && c.done && c.state === "failure").length;
}

/** The NOW sentence when nothing is running: "approved 14 min ago" (Yes) or "a1b2c3d on main" (Merged). Null when there is nothing true to say. */
export function nowSentence(i: { word: QuestionWord; approvedAt?: string | null; approvedBy?: string | null; mergeSha?: string | null; base: string; now: number }): string | null {
  if (i.word === "Merged") return i.mergeSha ? `${i.mergeSha} on ${i.base}` : null;
  if (i.word !== "Yes" || !i.approvedAt) return null;
  const t = Date.parse(i.approvedAt);
  if (!Number.isFinite(t)) return null;
  const m = Math.max(0, Math.round((i.now - t) / 60_000));
  const when = m < 1 ? "just now" : m < 90 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  return `approved ${when}`;
}
