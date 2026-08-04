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
  /** Which workspace view to open. */
  view: "git" | "diff";
  /** Source-control scope — the worktree's absolute path. Set for `view: "git"`. */
  root?: string;
  /** File-changes text filter — the worktree's folder name. Set for `view: "diff"`. */
  filter?: string;
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

export function requestWorktreeJump(req: { view: "git" | "diff"; root?: string; filter?: string }): void {
  pending = { ...req, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}
