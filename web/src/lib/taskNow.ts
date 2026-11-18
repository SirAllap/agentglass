// The NOW line of a Tasks card (mockup 07): what this card needs next, as one
// word and one action, from data the card already has. Checks and review come from the PR's rollup,
// which the project's one batched read carries (projectPullRequests).

import type { CardPr } from "./cardPrPick.ts";

export type TaskNowAction = "start" | "open-pr" | "finish-draft" | "ready-for-qa" | "rerun" | "review" | "fix-conflicts" | "none";
/** `key` is the part of `word` the card colours (mockup 07 colours "3 failed", not the whole line); `waiting` is the blocked-by line, drawn on its own. */
export interface TaskNow { word: string; action: TaskNowAction; label: string; key?: string; waiting?: string }

/** The baton ring of a card with no checks (mockup 07): 1 not started, 2 a PR in flight, 3 with QA. */
export function batonStep(action: TaskNowAction): 1 | 2 | 3 {
  return action === "start" || action === "none" ? 1 : action === "ready-for-qa" ? 3 : 2;
}

function decide(i: { status: "todo" | "doing" | "qa" | "done"; pr: Pick<CardPr, "number" | "state" | "draft"> | null; blockedBy?: string; /** The open PR's rollup, when read (jira/prs?project=). */ ci?: { state: "failing" | "passing" | "running" | "unknown"; failed: number }; conflicts?: boolean; review?: "approved" | "changes" | "awaiting" | "commented" | "none" | "unknown" }): TaskNow {
  if (i.status === "done") return { word: "done", action: "none", label: "" };
  const pr = i.pr;
  if (!pr) return i.status === "todo" ? { word: "not started", action: "start", label: "Start work" } : { word: "", action: "none", label: "" };
  if (i.status === "qa") return { word: "QA has it", action: "open-pr", label: "Open" };
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return { word: "merged", action: "ready-for-qa", label: "Ready for QA" };
  if (state === "CLOSED") return { word: `#${pr.number} closed`, action: "none", label: "" };
  if (pr.draft) return { word: `#${pr.number} is a draft`, action: "finish-draft", label: "Open" };
  if (i.conflicts) return { word: "conflicts", action: "fix-conflicts", label: "Fix with agent", key: "conflicts" };
  if (i.ci?.state === "failing") return { word: `${i.ci.failed} failed on #${pr.number}`, action: "rerun", label: `Re-run ${i.ci.failed}`, key: `${i.ci.failed} failed` };
  if (i.review === "changes") return { word: `changes asked on #${pr.number}`, action: "open-pr", label: "Open" };
  if (i.ci?.state === "running") return { word: `checks running on #${pr.number}`, action: "open-pr", label: "Open" };
  if (i.review === "awaiting") return { word: `you review #${pr.number}`, action: "review", label: "Review" };
  return { word: `#${pr.number} open`, action: "open-pr", label: "Open" };
}

/** Start work and Ready for QA both move the card; a card already at or past QA has no such step to offer. */
export function movesCard(action: TaskNowAction): boolean { return action === "start" || action === "ready-for-qa"; }

/** What a re-run is waiting to see change: the failed count and the state of the rollup the card was read with. */
export function rerunSig(ci: { state: string; failed: number } | null): string { return ci ? `${ci.state}:${ci.failed}` : ""; }
/** A re-run is pending while the rollup is still the one the click was made on. */
export function rerunPending(clicked: string | null, ci: { state: string; failed: number } | null): boolean { return clicked !== null && clicked === rerunSig(ci); }

/** How long a said line (a refusal, a launch note) stays in place of the NOW word. */
export const SAID_MS = 6000;

export function taskNow(i: Parameters<typeof decide>[0]): TaskNow {
  const n = decide(i);
  if (!i.blockedBy) return n;
  // A blocked card with no PR is not offered Start work: it says what it waits on.
  return { ...(i.pr ? n : { ...n, action: "none" as const, label: "" }), waiting: `waiting on ${i.blockedBy}` };
}
