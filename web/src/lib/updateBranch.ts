import type { PrLocalHead } from "../../../shared/types.ts";

/**
 * What "Update branch" is actually going to do, said before it does it.
 *
 * The button merges the base into the head ON GITHUB. That is the whole
 * operation, and it always was — but the copy of that branch on this machine
 * is a commit staler for every press, and nothing on the screen ever said so.
 * You find out later, from a push that is rejected or a diff that disagrees
 * with the pull request you just read.
 *
 * So the label carries the second half when there is one to carry, and when
 * there is not, the row says why in a sentence rather than doing something
 * clever. Only one state leads to a write here: a local branch that can be
 * fast-forwarded. Divergence, uncommitted work and a checkout in the middle of
 * a merge are all reported and left alone — this machine runs a dozen
 * worktrees with agents inside them, and moving somebody's HEAD to save them a
 * `git pull` is not a trade worth making.
 */
export interface UpdateBranchMove {
  label: string;
  /** The tooltip: the whole sentence, including the path when one matters. */
  title: string;
  /** Shown under the row when the local copy cannot come along. */
  note?: string;
  /** Whether to ask the server for the local fast-forward. */
  syncLocal: boolean;
}

const tail = (p?: string) => (p ? p.split("/").filter(Boolean).pop() || p : "");

export function updateBranchMove(behind: number | null, base: string, local?: PrLocalHead): UpdateBranchMove {
  const count = behind ? ` · ${behind} behind` : "";
  const far = behind
    ? `This branch is ${behind} commit${behind === 1 ? "" : "s"} behind ${base}. Merges the base into it, on GitHub.`
    : `Merge the base branch into this one — this updates the branch on GitHub`;

  // No answer about the local copy (an older server, a failed read) behaves
  // exactly as it did before: the remote half, and no promises about here.
  if (!local || local.sync === "absent") {
    return { label: `Update branch${count}`, title: far, syncLocal: false };
  }

  if (local.sync === "ff") {
    return {
      label: `Update branch & pull${count}`,
      title: `${far} Then fast-forwards your ${local.worktree ? `checkout in ${local.worktree}` : `local ${local.branch}`}.`,
      syncLocal: true,
    };
  }

  /* What to do about it, not only what will not happen. "It stays put" is true
     and leaves you nowhere; a local branch that is ahead is one push away from
     being the easy case, and that is the sentence worth reading. */
  const why = local.sync === "diverged"
    ? `your local ${local.branch} has ${local.ahead} commit${local.ahead === 1 ? "" : "s"} GitHub does not have — push ${local.ahead === 1 ? "it" : "them"} and this can pull too`
    : local.sync === "busy"
      ? `${tail(local.worktree)} is mid-merge — your local ${local.branch} stays put`
      : `uncommitted changes in ${tail(local.worktree)} — your local ${local.branch} stays put`;

  return {
    label: `Update branch${count}`,
    title: `${far} Your local copy is not touched: ${local.sync === "diverged"
      ? `it has ${local.ahead} commit${local.ahead === 1 ? "" : "s"} that GitHub does not`
      : local.sync === "busy"
        ? `${local.worktree} is mid-merge or mid-rebase`
        : `there are uncommitted changes in ${local.worktree}`}.`,
    note: why,
    syncLocal: false,
  };
}

/** Which files the panel's own merge of the two trees found in conflict, and
 *  whether the fetch behind it failed. */
export interface ConflictFilesSeen { files: string[]; stale: boolean }

/** A fresh merge of the pushed refs came back with nothing to settle. See the
 *  panel for why that outranks GitHub's CONFLICTING. */
export const gitSaysClean = (seen: ConflictFilesSeen | null): boolean =>
  !!seen && !seen.stale && seen.files.length === 0;

/**
 * Whether the panel treats the pull request as conflicted: "Update branch"
 * and the merge buttons go, "Resolve conflicts" comes.
 *
 * GitHub's CONFLICTING, unless git has just merged the same refs and found
 * nothing — or because we merged the two trees ourselves and found out. GitHub
 * computes `mergeable` lazily and answers UNKNOWN until somebody asks twice —
 * measured on this repository's own open pull request #464, which GitHub
 * called UNKNOWN while git named the one file it conflicts in. A gate that
 * waits for GitHub to make its mind up is a gate that is open exactly when the
 * answer matters most.
 *
 * A stale answer does not get a vote: if the fetch failed, what is on screen
 * is from whenever the refs were last pulled down, and taking buttons away on
 * that basis would be guessing.
 *
 * `refused` is the third witness: "Update branch" was pressed and GitHub
 * refused it over a conflict. That is GitHub attempting the very merge, and it
 * is the case that needs it: the button was only on screen while neither of
 * the other two had said "conflict", which left the refusal as an error with
 * nothing to press next. Unlike CONFLICTING it is not overruled by a clean git
 * merge — that override exists for a `mergeable` GitHub has not recomputed
 * since a push, and this is GitHub trying the merge just now, on the revision
 * the refusal is held against. Should the worktree merge come out clean after
 * all, Resolve conflicts says so: "nothing to resolve, just push it".
 */
export function prConflicted(mergeable: string, seen: ConflictFilesSeen | null, refused: boolean): boolean {
  return refused
    || (mergeable === "CONFLICTING" && !gitSaysClean(seen))
    || (!!seen && !seen.stale && seen.files.length > 0);
}
