// What the pill under a terminal pane says about its checkout, kept current.
//
// The pill's branch and changed-files count come out of the repo list the panel
// read when it opened, and nothing read it again: a rename or a new file showed
// when the panel was next reopened. `/git/repos` is a sweep of every checkout
// held 15 s on the server, so polling it is the wrong answer; `/git/repo` is the
// one `git status` of the checkout the pane stands in. The ceiling: only that
// row is refreshed, so the other rows of the list stay as old as the list.

import type { GitRepoRef } from "../../../shared/types.ts";

/** How often the focused pane's checkout is re-read while the window is looked at. */
export const PILL_POLL_MS = 3000;

/**
 * `repos` with the row for `fresh.root` brought up to date, and the SAME array
 * when nothing the pill shows moved: this runs on a timer, and a new array every
 * time would re-render the panel every time for an answer that did not change.
 * A root the list does not hold is not added: the list decides what exists.
 */
export function withFreshRepo(repos: GitRepoRef[], fresh: GitRepoRef | null | undefined): GitRepoRef[] {
  if (!fresh) return repos;
  const at = repos.findIndex((r) => r.root === fresh.root);
  const old = repos[at];
  if (!old) return repos;
  if (old.branch === fresh.branch && old.dirty === fresh.dirty && old.ahead === fresh.ahead && old.behind === fresh.behind) return repos;
  const next = repos.slice();
  next[at] = { ...old, branch: fresh.branch, dirty: fresh.dirty, ahead: fresh.ahead, behind: fresh.behind };
  return next;
}
