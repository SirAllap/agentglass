import type { PrMergeMethod, PrMergePolicy } from "./types.ts";

/**
 * Which way a pull request lands, and what to call it.
 *
 * The panel used to open on "Squash & merge" everywhere, because a constant
 * said so. That is the one method a repository is free to forbid, it rewrites
 * the branch's history into a single commit, and on a repository whose
 * convention is the merge commit — where the whole team's habit is to press
 * the blue button and change nothing — it was the wrong answer every single
 * time, offered as if it were the house default.
 *
 * The repository already knows the answer and GitHub publishes it. This
 * module turns those flags into the choice, the menu and the commit subject,
 * away from React so the phone and the desktop cannot drift and so the rule
 * can be tested without a DOM.
 */

export type MergeMethod = PrMergeMethod;

/**
 * All three in GitHub's own precedence: its merge button arrives checked on
 * the first of these that the repository allows. Copying that order is what
 * makes "open it and press merge" mean the same thing in both places.
 */
export const ALL_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

/** On the button. GitHub's own words for the merge commit — it is the default
 *  on most repositories now, and "the blue button" is the thing being matched,
 *  so the button should read like it. The other two keep the shorter form the
 *  row has always had. */
export const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash & merge",
  merge: "Merge pull request",
  rebase: "Rebase & merge",
};

/** In the menu, where the consequence fits next to the name. */
export const MERGE_OPTION: Record<MergeMethod, { label: string; hint: string }> = {
  merge: { label: "Create a merge commit", hint: "keeps every commit" },
  squash: { label: "Squash and merge", hint: "one commit" },
  rebase: { label: "Rebase and merge", hint: "no merge commit" },
};

/** The methods to offer. A repository that has not said gets all three — the
 *  menu never empties, it only ever narrows to the truth. */
export function allowedMethods(policy?: PrMergePolicy): MergeMethod[] {
  const allowed = (policy?.allowed ?? []).filter((m) => ALL_METHODS.includes(m));
  return allowed.length ? allowed : ALL_METHODS;
}

/**
 * The method to open on: what you chose here last, if this repository still
 * permits it, and otherwise what GitHub itself would have checked.
 *
 * The remembered choice is deliberately per repository rather than per pull
 * request. The decision belongs to the project's convention, not to the
 * branch, and it was previously component state that reset to squash whenever
 * you looked at the Files tab and came back.
 */
export function pickMergeMethod(saved: MergeMethod | undefined, policy?: PrMergePolicy): MergeMethod {
  const allowed = allowedMethods(policy);
  return saved && allowed.includes(saved) ? saved : allowed[0]!;
}

/**
 * The commit subject GitHub would have written, per method.
 *
 * This is what lands on the base branch for ever, and the dialog offers it for
 * editing before it does. It used to offer `Title (#7)` whatever you picked —
 * that is the squash convention, and using it for a merge commit leaves one
 * merge in the history that does not read like any of the others. A rebase
 * writes no commit of its own, so there is nothing to name.
 */
export function mergeSubject(
  method: MergeMethod,
  pr: { title: string; number: number; headRefName?: string; headRepoOwner?: string },
): string | undefined {
  if (method === "rebase") return undefined;
  if (method === "squash") return `${pr.title} (#${pr.number})`;
  const branch = pr.headRefName || "";
  const from = pr.headRepoOwner && branch ? `${pr.headRepoOwner}/${branch}` : branch;
  return from ? `Merge pull request #${pr.number} from ${from}` : `Merge pull request #${pr.number}`;
}

/** The part of a commit this app already keeps apart: the subject line, and
 *  everything under it. */
export type MergeCommit = { message: string; body?: string; isMerge?: boolean };

/**
 * The extended description GitHub would have offered, per method.
 *
 * The subject alone was all this dialog ever asked for, so everything the
 * merge could have SAID landed empty: a merge commit with no body, a squash
 * whose twenty commit messages died with the branch. GitHub prefills both
 * fields, and what it prefills is different per method:
 *
 * - **Merge commit** — the pull request's title. The subject is already
 *   `Merge pull request #7 from …`, which names the branch and not the work,
 *   so the title underneath is what makes the merge readable in a log.
 * - **Squash** — the commits, since the squash is about to destroy them. One
 *   commit contributes its own body (its subject is already in the subject
 *   field, `Title (#7)`); several become a `*` list, each with its own body
 *   indented under it, which is the shape GitHub writes.
 * - **Rebase** — nothing. It writes no commit of its own.
 *
 * Merge commits inside the branch are left out of the list. "Merge branch
 * 'main' into feature" describes plumbing that the squash is in the middle of
 * erasing; it is never part of what the change did.
 */
export function mergeBody(
  method: MergeMethod,
  pr: { title: string },
  commits: MergeCommit[] = [],
): string | undefined {
  if (method === "rebase") return undefined;
  if (method === "merge") return pr.title;
  const real = commits.filter((c) => !c.isMerge);
  if (!real.length) return "";
  if (real.length === 1) return (real[0]!.body ?? "").trim();
  return real
    .map((c) => {
      const body = (c.body ?? "").trim();
      // Continuation lines sit under the bullet, so a paragraph belonging to
      // the third commit cannot be read as belonging to the list.
      return body ? `* ${c.message}\n\n${body.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}` : `* ${c.message}`;
    })
    .join("\n\n");
}
