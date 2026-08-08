import type { GitBranchInfo, GitRepoRef, GitTreeState, MergeInfo, MergeSide } from "../../../shared/types.ts";

/**
 * What to call one side on screen.
 *
 * A branch name when there is one. Otherwise the commit's own subject and its
 * short hash — which is the honest answer for the commit a rebase is replaying
 * or a cherry-pick is applying, because it is a commit and not a branch. The
 * old code called it by the checkout's base branch, so a rebase three commits
 * in still said "feat", naming a tip two commits away from what was on screen.
 */
export function nameSide(s: MergeSide | null | undefined, fallback: string): string {
  if (!s) return fallback;
  if (s.ref) return s.ref;
  const short = s.sha.slice(0, 7);
  return s.subject ? `${s.subject} (${short})` : short;
}

/** Short labels for the two bands of a conflict, from the real operation. */
export function bandLabels(info: MergeInfo | null | undefined, branchName: string): { ours: string; theirs: string } {
  return {
    ours: nameSide(info?.ours, branchName),
    theirs: nameSide(info?.theirs, "the other side"),
  };
}

/**
 * "commit 2 of 3", when the operation replays a series.
 *
 * Null for a merge, which happens once. A rebase does not end when the last
 * file is resolved — it stops again on the next commit — and this is the only
 * place that fact is available to say.
 */
export function stepLabel(info: MergeInfo | null | undefined): string | null {
  if (!info?.step || !info.total || info.total < 2) return null;
  return `commit ${info.step} of ${info.total}`;
}

/**
 * Which side is which, per operation.
 *
 * This is the part a conflict prompt cannot leave out. "Prefer the incoming
 * change" is meaningless until incoming has a name, and under a rebase the
 * names swap: git replays YOUR commits onto the other branch, so "ours" is the
 * branch being replayed onto and "theirs" is your own work. An agent told to
 * favour theirs during a rebase, thinking that means the base, resolves every
 * conflict backwards with complete confidence.
 *
 * `info` is what git actually has in `.git`; `incoming` is the old deduction
 * from the checkout's base branch, kept as the fallback for callers that have
 * not read the operation yet. When both are present the read wins — the
 * deduction is wrong for any merge that is not of your own base.
 */
export function sidesOf(
  state: GitTreeState,
  branchName: string,
  incoming: string | null,
  info?: MergeInfo | null,
): string | null {
  const other = info?.theirs
    ? nameSide(info.theirs, incoming ?? "the other side")
    : incoming ?? "the other side";
  const mine = nameSide(info?.ours, branchName);
  if (state === "rebasing" && info?.ours) {
    // Under a rebase the names swap, so both are named from the read: "ours"
    // is the branch being landed on, which is NOT the branch you are on.
    const step = stepLabel(info);
    return `This is a REBASE, so the sides are inverted from what you may expect: "ours" is ${mine} (the branch my commits are being replayed onto) and "theirs" is my own commit being replayed${step ? `, ${step}` : ""}.`;
  }
  switch (state) {
    case "merging":
      return `"ours"/HEAD is ${mine}, "theirs"/MERGE_HEAD is ${other} (the incoming side).`;
    case "rebasing":
      // Worth spelling out rather than naming: this inversion is a classic way
      // to resolve a whole rebase the wrong way round.
      return `This is a REBASE, so the sides are inverted from what you may expect: "ours" is ${other} (the branch my commits are being replayed onto) and "theirs" is my own commit being replayed.`;
    case "cherry-picking":
      return `"ours"/HEAD is ${mine}; "theirs" is the commit being cherry-picked onto it${info?.theirs ? ` — ${other}` : ""}.`;
    case "reverting":
      return `"ours"/HEAD is ${mine}; "theirs" is the reverse of the commit being reverted${info?.theirs ? ` — ${other}` : ""}.`;
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
  info?: MergeInfo | null,
): string[] {
  const name = branch?.name || "(unknown branch)";
  const incoming = info?.theirs ? nameSide(info.theirs, "") : branch?.base ?? null;
  const doing = state === "clean" ? "mid-merge" : `mid-${state.replace(/ing$/, "")}`;
  const where = repoRef?.worktreeOf
    ? `the linked worktree ${root} (a worktree of ${repoRef.worktreeOf})`
    : root;

  const sides = sidesOf(state, name, branch?.base ?? null, info);
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
