/**
 * A modal of the Git view asked for from outside, held until the view can open
 * it.
 *
 * The same one-slot mailbox as chatIntent.ts and for the same reason: the Git
 * view owns the state of Insights, Bisect, Compare and Blame, a command can
 * arrive while another view is up, and the repository the modal belongs to is
 * only known once the view has read its repo list. So App latches the request
 * and opens the view, and the view drains it when it has a checkout, which
 * covers both orderings without a timing assumption.
 *
 * The request does not switch the view. The modals are portals, so they draw
 * over whichever view is up, and the Git view only has to be MOUNTED for them
 * (Workspace mounts it hidden when a request arrives, GitView loads its
 * checkout while one is open). An agent showing Insights from the terminal
 * therefore leaves the terminal, and the chat in it, where it was.
 *
 * Rebase is here because its editor only draws a plan: nothing moves until the
 * owner presses Start, and the server re-validates the plan then. Rescue is not:
 * it is the end of a worktree-removal flow, a promise that flow settles, and has
 * no state of its own to open.
 */
export type GitModalIntent =
  | { which: "insights" }
  | { which: "bisect" }
  | { which: "palette" }
  | { which: "compare"; base: string }
  | { which: "blame"; path: string }
  | { which: "rebase"; base: string };

/** Long enough for the view to mount and read its repos; short enough that a
 *  request nobody was there for does not fire at the next unrelated visit. */
export const GIT_MODAL_TTL_MS = 30_000;

let pending: { intent: GitModalIntent; at: number } | null = null;
const subs = new Set<() => void>();

export function latchGitModal(intent: GitModalIntent): void {
  pending = { intent, at: Date.now() };
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Read and clear; null when nothing fresh is waiting. */
export function takeGitModal(now: number = Date.now()): GitModalIntent | null {
  const p = pending;
  pending = null;
  return p && now - p.at <= GIT_MODAL_TTL_MS ? p.intent : null;
}

/** Whether a fresh request is waiting, without taking it. */
export function hasGitModal(now: number = Date.now()): boolean {
  return pending !== null && now - pending.at <= GIT_MODAL_TTL_MS;
}

export function subscribeGitModal(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
