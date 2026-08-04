// "Open this pull request."
//
// A one-slot request, the same shape and for the same reason as termIssue.ts:
// the thing asking is the notification list in the top bar, which can be open
// over any view, and the PR panel may not be mounted at all when it is pressed.
// So the request is left here, the shell switches to the PR view, and the panel
// picks it up the moment it exists.
//
// It carries the repo as well as the number because a number alone is not an
// identity — `#16175` names a different pull request in every repository, and
// the panel is pointed at one repo at a time. The panel decides what to do when
// they disagree; this only reports what was asked for.

export type PrJump = {
  /** `owner/name`, as the notification's own verdict carried it. */
  repo: string;
  number: number;
  /** Increments per request, so asking for the same PR twice is two requests.
   *  Without it, closing a PR and clicking the same notification again would
   *  look like the request that has already been served. */
  n: number;
};

let pending: PrJump | null = null;
const subs = new Set<() => void>();

export function subscribePrJump(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function prJump(): PrJump | null { return pending; }

export function requestPrJump(repo: string, number: number): void {
  pending = { repo, number, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Cleared by the panel once it has acted, not on arrival: a request made while
 *  the panel was still mounting must not be dropped on the way in. */
export function clearPrJump(): void {
  pending = null;
  subs.forEach((f) => f());
}
