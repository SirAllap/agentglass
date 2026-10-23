import type { PrClosedFacts } from "../../shared/types.ts";
import { whyLine } from "../../shared/prClosed.ts";

/**
 * What a merged or closed pull request ended as, read off one GraphQL node.
 * Pure: the node shape is `SEL_CLOSED` in prs.ts plus the rollup counts the row
 * details already ask for, and `isBot` is injected so this file does not import
 * the module that imports it.
 */

/** The fields a finished pull request adds to the row-details read. */
export const SEL_CLOSED = `
      state createdAt closedAt mergedAt mergedBy{login}
      closer: timelineItems(last:1, itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}}
      mergeCommit{messageHeadline parents(first:2){totalCount}}
      commitTotal: commits{totalCount}
      issueComments: comments{totalCount}
      lastRemarks: comments(last:5){nodes{body author{login}}}
      threadSizes: reviewThreads(first:100){nodes{comments{totalCount}}}`;

/** The names of the red checks, asked only for the few finished pull requests that ended red. */
export const SEL_FAILING_NAMES = `commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        __typename
        ... on CheckRun{name conclusion}
        ... on StatusContext{context state}
      }}}}}}`;

const RED_RUN = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "CANCELLED", "ACTION_REQUIRED"]);

/** Red check names from the contexts node, first two, in the order GitHub lists them. */
export function failingNames(node: any): string[] {
  const out: string[] = [];
  for (const c of node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) {
    const name = c?.__typename === "CheckRun" && RED_RUN.has(String(c.conclusion)) ? c.name
      : c?.__typename === "StatusContext" && (c.state === "FAILURE" || c.state === "ERROR") ? c.context : null;
    if (typeof name === "string" && name && !out.includes(name)) out.push(name);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * How it landed. GitHub has no field for it, so it is read off the merge commit:
 * two parents is a merge commit; one parent whose headline ends in "(#N)" is the
 * squash GitHub writes; one parent otherwise is a rebase. Ceiling: a squash with
 * a hand-edited title that drops the "(#N)" reads as a rebase; no merge commit
 * (a deleted repository state) is null.
 */
export function mergeMethod(node: any): PrClosedFacts["method"] {
  if (node?.state !== "MERGED" && !node?.mergedAt) return null;
  const mc = node?.mergeCommit;
  if (!mc) return null;
  if ((mc.parents?.totalCount ?? 1) > 1) return "merge";
  return new RegExp(`\\(#${Number(node.number)}\\)\\s*$`).test(String(mc.messageHeadline ?? "")) ? "squash" : "rebase";
}

/** Each person's LAST standing verdict, how many rounds of review there were, how much was said. */
export function reviewFacts(node: any): PrClosedFacts["reviews"] {
  const last = new Map<string, string>();
  let rounds = 0;
  const reviews = [...(node?.reviews?.nodes ?? [])]
    .filter((r) => r?.submittedAt && r?.author?.login)
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED") rounds++;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") last.set(r.author.login, r.state);
    else if (r.state === "DISMISSED") last.delete(r.author.login);
  }
  const who = (state: string) => [...last].filter(([, s]) => s === state).map(([login]) => login);
  const lines = (node?.threadSizes?.nodes ?? []).reduce((n: number, t: any) => n + (Number(t?.comments?.totalCount) || 0), 0);
  return {
    approved: who("APPROVED"), changes: who("CHANGES_REQUESTED"), rounds,
    comments: (Number(node?.issueComments?.totalCount) || 0) + lines,
  };
}

/** The last conversation comment by a person (the review bot's verdict is not "why it was dropped"). */
export function lastHumanRemark(node: any, isBot: (login: string) => boolean): string | null {
  const list = node?.lastRemarks?.nodes ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c?.author?.login && !isBot(c.author.login)) return whyLine(c.body);
  }
  return null;
}

/**
 * The facts of a finished node, or null for one that is still open (nothing is
 * stored for it: it can change). `rollup` is the node's final check counts.
 */
export function closedFactsFromNode(
  node: any,
  rollup: { total: number; success: number; failure: number; skipped: number },
  failing: string[],
  isBot: (login: string) => boolean,
): PrClosedFacts | null {
  const merged = node?.state === "MERGED";
  if (!node || (!merged && node.state !== "CLOSED")) return null;
  const at = (merged ? node.mergedAt : node.closedAt) || node.closedAt || node.mergedAt;
  if (!at || !node.createdAt) return null;
  return {
    at, openedAt: node.createdAt,
    by: (merged ? node.mergedBy?.login : node.closer?.nodes?.[0]?.actor?.login) || null,
    method: mergeMethod(node),
    checks: { total: rollup.total, success: rollup.success, failure: rollup.failure, skipped: rollup.skipped, failing: rollup.failure > 0 ? failing.slice(0, 2) : [] },
    commits: Number(node.commitTotal?.totalCount) || 0,
    reviews: reviewFacts(node),
    why: merged ? null : lastHumanRemark(node, isBot),
  };
}
