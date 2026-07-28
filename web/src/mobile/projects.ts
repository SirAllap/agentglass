// One row per project, not per checkout.
//
// A linked worktree is the same repository on another branch. The Repos tab
// listed them side by side, so "agentglass" and "remote-phone" read as two
// different projects when they are one project in two places — and the branch,
// which is the thing you actually want to choose, was nowhere.
//
// The server already says which is which: `worktreeOf` names the main repo on
// every linked checkout. This folds on that, and the screen offers the
// checkouts inside — pick the repository, then pick the work.
//
// Its own module, with no imports, so a test of it does not pull the whole
// application graph in behind it.

export interface Checkout {
  ref: { root: string; worktreeOf?: string };
  name: string;
}

export interface ProjectRow<T extends Checkout> {
  /** The checkout that represents the project: its main repo when we have it. */
  main: T;
  /** Every checkout of it, the main one first. */
  checkouts: T[];
}

export function projectRows<T extends Checkout>(repos: readonly T[]): ProjectRow<T>[] {
  const byRoot = new Map(repos.map((r) => [r.ref.root, r]));
  const groups = new Map<string, ProjectRow<T>>();
  for (const r of repos) {
    const parent = r.ref.worktreeOf && byRoot.has(r.ref.worktreeOf) ? r.ref.worktreeOf : r.ref.root;
    let g = groups.get(parent);
    if (!g) {
      // The parent may be absent from a scoped list. Then the worktree stands
      // in for its own project rather than disappearing from the tab.
      g = { main: byRoot.get(parent) ?? r, checkouts: [] };
      groups.set(parent, g);
    }
    g.checkouts.push(r);
  }
  for (const g of groups.values()) {
    g.checkouts.sort((a, b) =>
      (a.ref.root === g.main.ref.root ? -1 : b.ref.root === g.main.ref.root ? 1 : 0)
      || a.name.localeCompare(b.name));
  }
  return [...groups.values()].sort((a, b) => a.main.name.localeCompare(b.main.name));
}
