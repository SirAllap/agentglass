/**
 * A dialog of the Lantern or the Terminal asked for from outside, held until the
 * view that owns it can open it.
 *
 * The same one-slot mailbox as gitModalIntent.ts and for the same reason: the
 * view owns the state of its dialog, a command can arrive while another view is
 * up, so App latches the request and opens the view, and the view drains it when
 * it mounts or when a new request arrives. Both orderings work without a timing
 * assumption.
 *
 * Neither dialog does anything by being open. The schedule dialog creates a
 * schedule when the owner submits it; the resume list resumes a session when the
 * owner picks one.
 */
export type ViewModal = "lantern.schedule" | "terminal.resume";

/** Long enough for the view to mount; short enough that a request nobody was
 *  there for does not fire at the next unrelated visit. */
export const VIEW_MODAL_TTL_MS = 30_000;

let pending: { which: ViewModal; at: number } | null = null;
const subs = new Set<() => void>();

export function latchViewModal(which: ViewModal): void {
  pending = { which, at: Date.now() };
  for (const fn of subs) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Whether a fresh request for `which` is waiting, leaving it there. For a
 *  parent that must open its menu before the child can take the request. */
export function peekViewModal(which: ViewModal, now: number = Date.now()): boolean {
  return pending !== null && pending.which === which && now - pending.at <= VIEW_MODAL_TTL_MS;
}

/** Read and clear `which`; false when nothing fresh is waiting for it. A request
 *  for the other dialog is left alone. */
export function takeViewModal(which: ViewModal, now: number = Date.now()): boolean {
  if (!peekViewModal(which, now)) return false;
  pending = null;
  return true;
}

export function subscribeViewModal(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
