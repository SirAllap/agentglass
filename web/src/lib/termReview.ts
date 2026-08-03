// "Review this pull request, but in my terminal."
//
// A one-slot request rather than a call, for the same reason chat focus is one:
// the pull request panel cannot reach the terminal's websocket, and the terminal
// view may not even be mounted when the button is pressed. The request is left
// here, the workspace switches views, and the terminal picks it up when it has a
// socket to send it on.

export type TermReview = { root: string; number: number; n: number };

let pending: TermReview | null = null;
const subs = new Set<() => void>();

export function subscribeTermReview(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function termReview(): TermReview | null { return pending; }

/** `n` increments so that asking for the same pull request twice is two
 *  requests. Without it, reviewing #17219, closing the window and asking again
 *  would be indistinguishable from the request already served. */
export function requestTermReview(root: string, number: number): void {
  pending = { root, number, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Called once the terminal has actually sent it. Clearing on *send* rather
 *  than on arrival means a request made while the socket was still connecting
 *  is not silently dropped. */
export function clearTermReview(): void {
  pending = null;
  subs.forEach((f) => f());
}
