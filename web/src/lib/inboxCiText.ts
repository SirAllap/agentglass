/*
 * The second line of an Inbox row for a failed CI run: which part failed.
 *
 * GitHub's notification names the workflow and the branch and nothing else
 * ("CI workflow run failed for feat/thing branch"), so the row said that and
 * nothing more. The failing part is already known to the app — the board card
 * names it from failures the app read (prFailureHint.ts) — so this joins the
 * two: branch -> the loaded pull request -> its failing checks -> the cached
 * read. Nothing here asks GitHub; a row whose failures nobody opened gets the
 * names of the failing checks, and one with no loaded pull request is left as
 * it was.
 *
 * The ceiling: a branch is matched against the pull requests the panel has
 * loaded. A run on a branch with no loaded pull request (main, a push with no
 * PR) has no line, and says what it always did. The branch is read out of
 * GitHub's English title; a title that stops matching degrades to no line, never
 * to a wrong one.
 */
import type { CheckFailureSummary, InboxItem, PrSummary } from "../../../shared/types.ts";
import { failureHint } from "./prFailureHint.ts";

export interface SuiteTitle { workflow: string; branch: string }

/** `CI / Tests workflow run, Attempt #2 failed for feat/x branch`. Only the failed ones: passed and cancelled rows are not this line's business. */
export function parseSuiteTitle(title: string): SuiteTitle | null {
  const m = /^(.+?) workflow run(?:, Attempt #\d+)? failed for (.+) branch$/.exec(title.trim());
  return m ? { workflow: m[1]!, branch: m[2]! } : null;
}

/** What the line says. The tail is its own piece because a narrow row cuts `text` and must never cut the count. */
export interface CiLine { text: string; tail: string }

/**
 * The line under a failed CI row, or null when the row should stay as it is: not a check suite, not a
 * failure, no pull request on that branch, or that pull request has nothing failing now (a re-run went green).
 */
export function inboxCiLine(
  item: Pick<InboxItem, "type" | "title">,
  prs: Pick<PrSummary, "headRefName" | "checks">[],
  summaryOf: (job: string) => CheckFailureSummary | undefined,
): CiLine | null {
  if (item.type !== "CheckSuite") return null;
  const t = parseSuiteTitle(item.title);
  if (!t) return null;
  const failing = prs.find((p) => p.headRefName === t.branch)?.checks?.failing ?? [];
  if (!failing.length) return null;
  const ofWorkflow = failing.filter((c) => c.workflow === t.workflow);
  const mine = ofWorkflow.length ? ofWorkflow : failing;
  const hint = failureHint(mine, summaryOf);
  if (hint) return { text: hint.title, tail: hint.more > 0 ? ` +${hint.more} more` : "" };
  return { text: mine.slice(0, 2).map((c) => c.name).join(", "), tail: `${mine.length > 2 ? ` +${mine.length - 2} more` : ""} failing` };
}
