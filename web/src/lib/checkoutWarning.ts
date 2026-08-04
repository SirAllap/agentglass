/**
 * What a "checkout" actually costs, said out loud before it happens.
 *
 * Written after it went wrong twice in one morning on a shared repository. A
 * branch was picked from a list that is mostly used for NAVIGATION — repos and
 * worktrees, where a click means "take me there" — and the same click on a
 * branch meant "move that branch into the directory I happen to be standing
 * in". It read as going somewhere and it was a move.
 *
 * The three facts nobody has in mind at the moment of clicking, and which every
 * surface that can do this now has to state:
 *
 *  1. WHERE. "Here" is a directory with a name, and in a repo with twenty
 *     worktrees the one you are standing in is rarely the one you are thinking
 *     about.
 *
 *  2. WHAT IT DISPLACES. A directory holds exactly one branch, so checking one
 *     out evicts whatever was there. That is how a ticket branch got swapped
 *     out from under a worktree three minutes after a commit landed on it.
 *
 *  3. WHAT FOLLOWS YOU. Uncommitted changes live in the DIRECTORY, not on the
 *     branch — which is why a checkout does not lose them, and exactly why they
 *     come along and end up sitting on top of a branch they have nothing to do
 *     with. The correct mental model produces the surprising outcome, so it has
 *     to be spelled out rather than assumed.
 *
 * And the fourth, which is the one that made the state incomprehensible
 * afterwards: a branch can be checked out in ONE directory at a time, so this
 * also pins it there and removes it from everywhere else.
 */

export type CheckoutTarget = {
  /** The branch about to be checked out. */
  branch: string;
  /** The directory it will land in — its name, as the user knows it. */
  dir: string;
  /** What that directory currently has checked out, when it is something else. */
  displacing?: string | null;
  /** Uncommitted or untracked files sitting in that directory right now. */
  dirty?: number;
};

/** The question, phrased so that reading only the title is still enough. */
export function checkoutTitle(t: CheckoutTarget): string {
  return `Check out ${t.branch} in ${t.dir}?`;
}

export function checkoutBody(t: CheckoutTarget): string {
  const lines: string[] = [];
  if (t.displacing && t.displacing !== t.branch) {
    lines.push(`${t.dir} currently has ${t.displacing}. It will be swapped out — the branch keeps every commit, but this folder stops being its home.`);
  }
  if (t.dirty) {
    // The one that surprises people who understand git correctly.
    lines.push(`${t.dirty} uncommitted ${t.dirty === 1 ? "change" : "changes"} in this folder will come along and show up on top of ${t.branch}. They belong to the directory, not to the branch.`);
  }
  lines.push(`${t.branch} can only be checked out in one folder at a time, so it will live here and stop being available in any other checkout.`);
  return lines.join("\n\n");
}

/** Ready to hand to `ask()`. Not `danger`: nothing is destroyed — but it is a
 *  move, and a move is worth a sentence. */
export function checkoutConfirm(t: CheckoutTarget) {
  return {
    title: checkoutTitle(t),
    body: checkoutBody(t),
    confirmLabel: `Check out in ${t.dir}`,
    cancelLabel: "Cancel",
  };
}

/**
 * Whether this even needs asking.
 *
 * Checking a branch out into the folder it already lives in is a no-op, and a
 * confirmation for a no-op is how confirmations stop being read.
 */
export function needsCheckoutConfirm(t: CheckoutTarget): boolean {
  return t.displacing !== t.branch;
}

/**
 * How to say where a branch is, everywhere.
 *
 * The picker used to badge branches `WT` or `BR`, which reads as two KINDS of
 * thing — and led to "the worktree turned into a branch and the branch into a
 * worktree", because clicking one made the labels swap. They were never kinds:
 * a branch is either open in some folder or it is not. So the label names the
 * folder instead of inventing a category, and a branch that is free simply has
 * nothing next to it.
 */
export function whereBranchLives(worktreeDir: string | null | undefined): string | null {
  return worktreeDir ? worktreeDir : null;
}
