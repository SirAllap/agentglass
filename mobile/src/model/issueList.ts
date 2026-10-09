/*
 * What the Issues screen decides apart from drawing: which rows a search
 * keeps, and what a linked pull request says about itself.
 *
 * Search narrows the rows already loaded, like the Cards tab does, so typing
 * costs GitHub nothing. Ceiling: an issue that is not on the list being looked
 * at (another filter, another repository) is not found from here.
 */
import { matchesQuery } from "../../../shared/taskref.ts";
import type { IssuePr, IssueRow, PrSummary } from "../../../shared/types.ts";
import { bannerLook, type Banner } from "./prCard.ts";

/** Every word must appear in the title, the `#number`, a label, the author or
 *  an assignee. Case does not matter, a leading `#` is the number's, and an
 *  empty box keeps everything (the shared matcher's "nothing" is for a caller
 *  handed an id, which this is not). */
export function issueMatches(issue: IssueRow, text: string): boolean {
  const q = text.split(/\s+/).map((w) => w.replace(/^#+/, "")).filter(Boolean).join(" ");
  if (!q) return true;
  return matchesQuery([issue.title, String(issue.number), issue.author, ...issue.assignees, ...issue.labels.map((l) => l.name)], q);
}

/**
 * What to print under a linked pull request, beyond whether it will close the
 * issue: the same verdict its own card carries ("Changes requested by ada"),
 * taken from the repository's open list. Null when the list has nothing on it
 * (merged, closed, or not in the page read) — the row then says only what it
 * knew before.
 */
export function prVerdict(pr: IssuePr, open: PrSummary[] | null | undefined): Banner | null {
  if (pr.state !== "OPEN") return null;
  const summary = open?.find((p) => p.number === pr.number);
  return summary ? bannerLook(summary, { forMe: false }) : null;
}
