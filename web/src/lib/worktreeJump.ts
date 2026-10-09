// "Open Source control / File changes for this worktree."
//
// Same one-slot shape and reasoning as prJump.ts: the trigger is a button in
// the Terminal chrome, and the git / file-changes panel may not be the view on
// screen when it is pressed. The request is left here, the shell switches to the
// target view (App), and the panel applies the scope or filter from the same
// store the moment it is shown — every view stays mounted, so its subscription
// is always live.
//
// The worktree is chosen from a picker, NOT read from the focused pane.
// Measured against a live fleet: the tmux pane's cwd and the agent's session
// both report the PARENT repo, never the linked worktree the agent edits in (it
// works there via `git -C` / `cd` in subcommands without moving its own cwd), so
// there is no reliable pane→worktree signal to read. The picker is the honest
// source, and the folder name it hands over is exactly what File changes filters
// file paths against.

export type WorktreeJump = {
  /**
   * Which workspace view to open.
   *
   * "term" carries no `root`/`filter` — a terminal issue (termIssue.ts)
   * already named the worktree it opens a window in; this only has to bring
   * the view holding that window forward, the same way a git-issue handoff
   * brings "git" forward.
   */
  view: "git" | "diff" | "term";
  /** Source-control scope — the worktree's absolute path. Set for `view: "git"`. */
  root?: string;
  /** File-changes text filter — the worktree's folder name. Set for `view: "diff"`. */
  filter?: string;
  /** Which Git tab to land on, for `view: "git"`. Without it the panel stays
   *  on whatever tab it was last left on, which is right for a worktree
   *  switch and wrong for a button that promises to show one thing. */
  tab?: "changes" | "log" | "branches";
  /** Increments per request, so asking for the same worktree twice is two
   *  requests: each consumer compares it against the last `n` it served, which
   *  is what lets the request survive a view that was still hidden when it
   *  arrived without being replayed every time that view is shown again. */
  n: number;
};

let pending: WorktreeJump | null = null;
const subs = new Set<() => void>();

export function subscribeWorktreeJump(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function worktreeJump(): WorktreeJump | null { return pending; }

export type WorktreeJumpRequest = Omit<WorktreeJump, "n">;

export function requestWorktreeJump(req: WorktreeJumpRequest): void {
  pending = { ...req, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}
