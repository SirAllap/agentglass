import type { PrBranchSummary } from "../../../shared/types.ts";

/**
 * Where the branch's pull-request chip goes when it is pressed.
 *
 * It was a line of JSX, and that is the whole reason this file exists.
 *
 * Reported with four screenshots: from Source control, standing on the branch
 * whose pull request the chip was naming, pressing it put the panel into
 * "Searching… 1 of 75", then "388 matches", then a board filtered to `Custom` —
 * and never showed the pull request. The chip had the number in its hand and
 * spent it on a query box. The library was innocent: `openPrs` sends a SEARCH
 * deliberately, because most of its callers hold a string and not an identity.
 * What was wrong was which door the chip knocked on.
 *
 * The fix lived inside an `onClick` for a while, and a test could only reach it
 * by reading the component's source and grepping for the call. That kind of
 * test is green for the wrong reason the moment somebody spells the same wrong
 * thing differently — `openPrs(\`${pr.number}\`)` is the same bug as
 * `openPrs(String(pr.number))` and no substring assertion tells them apart. So
 * the decision is a function, and the function is what is tested.
 *
 * ONE destination, not two. There was a search fallback here for "we know the
 * number but not the repository"; the dead-code audit proved that state
 * unreachable — `from` comes back only on the one success path in
 * `prsForBranch`, and that path always sets `repo` from `repoIdFor`, which
 * returns null unless it parsed a real owner/name. Reintroducing the fallback
 * would not be defensive, it would be the reported bug with a condition in
 * front of it. So the answer to "we have no repository" is the same as the
 * answer to "there is no pull request": draw nothing. The two are kept as
 * separate variants rather than one `null` because they are different facts
 * about the branch, and a reader who ever meets `no-repository` on screen has
 * met something the audit says cannot happen.
 *
 * Returning the summary itself in the `open` arm is what removes the `!` at the
 * call site: the caller had `openPr(prRepo!, branchPr.number)`, a non-null
 * assertion standing in for a proof kept in a comment. Now the type carries it.
 */
export type ChipTarget =
  | { kind: "open"; repo: string; pr: PrBranchSummary }
  | { kind: "no-pull-request" }
  | { kind: "no-repository" };

export function chipTarget(
  repo: string | null | undefined,
  pr: PrBranchSummary | null | undefined,
): ChipTarget {
  if (!pr) return { kind: "no-pull-request" };
  // An empty string is what a repository field looks like when the answer came
  // back without one, and `openPr("", 17)` is a jump to nowhere.
  if (!repo) return { kind: "no-repository" };
  return { kind: "open", repo, pr };
}
