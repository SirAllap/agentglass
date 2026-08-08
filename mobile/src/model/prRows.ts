/**
 * Which directories to ask about, and what to do when they answer the same.
 *
 * This machine keeps several linked worktrees of the same repository — that is
 * the point of them — and the phone asked every one of them for its open pull
 * requests. GitHub answered each with the same list, because a worktree is not
 * a fork: it is the same remote and the same pull requests. So one red pull
 * request drew three identical cards, the Now hero counted three things wanting
 * you, and the tab badge agreed with it.
 *
 * Both halves live here rather than inline in the fetch, so both can be tested
 * without the application graph behind them.
 */

/** A checkout, reduced to what deciding this needs. */
export interface Checkout {
  root: string;
  /** Set when this checkout is a linked worktree of another one — see
   *  GitRepoRef in shared/types.ts. */
  worktreeOf?: string;
}

/**
 * The checkouts worth asking, which is one per repository.
 *
 * A worktree whose main checkout is *not* in the list is kept: the answer has
 * to come from somewhere, and dropping it would lose the pull requests of a
 * repository the phone can otherwise see.
 */
export function mainCheckouts<T extends Checkout>(list: readonly T[]): T[] {
  const roots = new Set(list.map((r) => r.root));
  return list.filter((r) => !(r.worktreeOf && roots.has(r.worktreeOf)));
}

/**
 * One row per pull request, however many checkouts asked about it.
 *
 * Keyed on the pull request's own identity — its URL, falling back to the
 * repository and number — rather than on the directory that happened to fetch
 * it. `mine` is kept over `review` when both come back: a pull request you own
 * and were also asked to review is a thing to fix, and the queue should say so.
 */
export function dedupePrs<T extends { repo: string; pr: { number: number; url?: string }; scope: "mine" | "review" }>(
  rows: readonly T[],
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) {
    // The URL identifies the pull request on GitHub; the local directory name
    // does not, and two checkouts of one repo do not have to share it.
    const key = row.pr.url || `${row.repo}#${row.pr.number}`;
    const seen = out.get(key);
    if (!seen || (seen.scope === "review" && row.scope === "mine")) out.set(key, row);
  }
  return [...out.values()];
}
