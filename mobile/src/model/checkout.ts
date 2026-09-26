/*
 * Which checkout a directory is in.
 *
 * Source control opened from the terminal used to show the FIRST checkout the
 * machine listed, whatever pane it was opened from: `found[0]`. On a machine
 * working a worktree per pull request that is somebody else's branch, drawn
 * convincingly under the name of the one you were looking at.
 *
 * A pane's directory is often below the checkout's root (a shell that has
 * `cd`'d into `src/`), so this is the longest root that contains it, not an
 * exact match. No match is the directory itself: the server's status route
 * takes a path and answers for whatever repository holds it.
 */
export function checkoutFor(where: string, roots: string[]): string {
  const clean = where.replace(/\/+$/, "");
  let best: string | null = null;
  for (const root of roots) {
    const r = root.replace(/\/+$/, "");
    if ((clean === r || clean.startsWith(r + "/")) && (!best || r.length > best.length)) best = root;
  }
  return best ?? where;
}

/**
 * The window a piece of work is in, among the terminal's tabs.
 *
 * "Open in terminal" on a started issue carries the worktree it was started in
 * and the window name it was given (`i231`). The name wins when a tab carries
 * it — two windows can sit in one worktree — and the directory is the fallback,
 * for a window somebody has since renamed: a tab in the worktree itself before
 * one in a folder under it, whatever order the tabs come in. The first match
 * used to win, so a shell left in `src/` could be picked over the agent's own
 * window at the root because it had the lower index.
 */
export function paneFor<T extends { label: string; where: string }>(
  tabs: T[], where: string, window?: string,
): T | null {
  const p = where.replace(/\/+$/, "");
  const at = (t: T): boolean => t.where.replace(/\/+$/, "") === p;
  const inside = (t: T): boolean => at(t) || t.where.replace(/\/+$/, "").startsWith(p + "/");
  const named = window
    ? tabs.find((t) => inside(t) && t.label.split(/\s+/).slice(1).join(" ").split("·")[0] === window)
      ?? tabs.find((t) => t.label.split(/\s+/).slice(1).join(" ").split("·")[0] === window)
    : undefined;
  return named ?? tabs.find(at) ?? tabs.find(inside) ?? null;
}

/**
 * Whether a checkout's branch can be looked up on GitHub.
 *
 * A detached HEAD reports the branch as "(detached)" — the server's word for
 * "there is none" — and the screen asked GitHub about a branch of that name
 * and printed "GitHub did not answer", which blames the wrong party. `reason`
 * null means the branch is not known yet: the caller keeps waiting.
 */
export function branchLookup(
  branch: string | undefined,
): { ask: true; branch: string } | { ask: false; reason: string | null } {
  if (!branch) return { ask: false, reason: null };
  if (branch === "(detached)") {
    return { ask: false, reason: "This checkout has no branch (detached HEAD), so there is no pull request to look for. Check out a branch first." };
  }
  return { ask: true, branch };
}
