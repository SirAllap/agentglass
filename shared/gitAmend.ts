// When "Amend last commit" is refused, as one plain sentence. Shared by the
// server (which refuses the act) and the dock (which shuts the button when the
// answer is already known), so the two cannot disagree.

export interface AmendFacts {
  /** The repository has no commit at all yet. */
  empty?: boolean;
  /** HEAD is not on a branch. */
  detached: boolean;
  /** treeState(): "clean", or the operation in progress ("merging", "rebasing"...). */
  state: string;
  /** Some remote-tracking branch already contains the last commit. */
  onRemote: boolean;
}

export function amendRefusal(f: AmendFacts): string | undefined {
  if (f.empty) return "There is no commit to amend yet.";
  if (f.state !== "clean") return `This checkout is ${f.state}. Finish or abandon that before amending.`;
  if (f.detached) return "HEAD is not on a branch, so there is no branch commit to amend. Switch to a branch first.";
  if (f.onRemote) return "The last commit is already on a remote. Amending rewrites it, so the next push would have to be forced.";
  return undefined;
}
