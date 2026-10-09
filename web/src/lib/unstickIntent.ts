/**
 * An Unstick dialog asked for from outside (the `pr.unstick` door), held until
 * the pull request view can open it.
 *
 * The same one-slot mailbox as gitModalIntent.ts and for the same reason: the
 * view owns the state of its dialog and a command can arrive while another view
 * is up. The request names a pull request; the view selects it and opens the
 * dialog, which decides for itself (shared/unstick.ts) whether the pull request
 * qualifies and says so if it does not. Opening it runs nothing: the person's
 * click on the confirm button is the only thing that does.
 */
export interface UnstickRequest { root: string; number: number }

/** Long enough for the view to mount; short enough that a request nobody was there for does not fire at the next visit. */
export const UNSTICK_TTL_MS = 30_000;

let pending: { req: UnstickRequest; at: number } | null = null;
const subs = new Set<() => void>();

export function latchUnstick(req: UnstickRequest): void {
  pending = { req, at: Date.now() };
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Read and clear; null when nothing fresh is waiting. */
export function takeUnstick(now: number = Date.now()): UnstickRequest | null {
  const p = pending;
  pending = null;
  return p && now - p.at <= UNSTICK_TTL_MS ? p.req : null;
}

export function subscribeUnstick(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
