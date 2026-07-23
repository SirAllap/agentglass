import type { GitBranchInfo, GitRepoRef, GitTreeState } from "../../../shared/types.ts";

/**
 * Which side is which, per operation.
 *
 * This is the part a conflict prompt cannot leave out. "Prefer the incoming
 * change" is meaningless until incoming has a name, and under a rebase the
 * names swap: git replays YOUR commits onto the other branch, so "ours" is the
 * branch being replayed onto and "theirs" is your own work. An agent told to
 * favour theirs during a rebase, thinking that means the base, resolves every
 * conflict backwards with complete confidence.
 */
export function sidesOf(state: GitTreeState, branchName: string, incoming: string | null): string | null {
  const other = incoming ?? "the other side";
  switch (state) {
    case "merging":
      return `"ours"/HEAD is ${branchName}, "theirs"/MERGE_HEAD is ${other} (the incoming side).`;
    case "rebasing":
      // Worth spelling out rather than naming: this inversion is a classic way
      // to resolve a whole rebase the wrong way round.
      return `This is a REBASE, so the sides are inverted from what you may expect: "ours" is ${other} (the branch my commits are being replayed onto) and "theirs" is my own commit being replayed.`;
    case "cherry-picking":
      return `"ours"/HEAD is ${branchName}; "theirs" is the commit being cherry-picked onto it.`;
    case "reverting":
      return `"ours"/HEAD is ${branchName}; "theirs" is the reverse of the commit being reverted.`;
    default:
      return null;
  }
}

/**
 * The situation, not just the file list.
 *
 * Everything here is already on screen — the branch, its base, whether this
 * checkout is a linked worktree, what git stopped in the middle of. Leaving it
 * out made the agent re-derive from `git status` what the panel already knew,
 * and guess at the one thing status does not spell out: which ref is incoming.
 */
export function conflictBriefing(
  root: string,
  branch: GitBranchInfo | undefined,
  repoRef: GitRepoRef | undefined,
  state: GitTreeState,
  rels: string[],
): string[] {
  const name = branch?.name || "(unknown branch)";
  const incoming = branch?.base ?? null;
  const doing = state === "clean" ? "mid-merge" : `mid-${state.replace(/ing$/, "")}`;
  const where = repoRef?.worktreeOf
    ? `the linked worktree ${root} (a worktree of ${repoRef.worktreeOf})`
    : root;

  const sides = sidesOf(state, name, incoming);
  return [
    `I am on ${name} in ${where}, ${doing}${incoming ? `, bringing ${incoming} in` : ""}.`,
    ...(sides ? [sides] : []),
    "",
    `Git has left ${rels.length} file(s) conflicted:`,
    "",
    ...rels.map((r) => `- ${r}`),
    "",
  ];
}

/** The ask, unchanged in substance: reconcile intent, explain the judgement
 *  calls, and stop short of committing so the resolution can be reviewed. */
export const CONFLICT_ASK = [
  "Please resolve each conflict, keeping both sides' intent where they do",
  "different things. Where they do the same thing differently, prefer the",
  "incoming side named above. Explain anything you had to choose between.",
  "Do not commit — leave the resolution staged so I can review it.",
];
