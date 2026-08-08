// "Show me this folder in Files."
//
// Same one-slot shape and reasoning as worktreeJump.ts, for the other direction:
// the palette can be opened from anywhere — a terminal, a diff, a pull request —
// and a folder chosen in it is a PLACE, not a document. There is nothing to
// raise over the screen for a directory; the answer is the tree, walked there.
//
// So the request is left here, the shell switches to the Files view (App), and
// the panel applies it the moment it is shown. Every view stays mounted, so the
// subscription is always live — but Files may never have been opened in this
// session at all, which is exactly why this cannot be a prop.
//
// It carries the checkout as well as the path. The palette searches whichever
// checkout it was pointed at, which is very often NOT the one Files happens to
// be showing; handing over the path alone would reveal a folder of the same
// name in the wrong worktree, or nothing at all, and both look like a bug in
// the search rather than in the handover.

export type FilesReveal = {
  /** The checkout's absolute path — Files switches to it before revealing. */
  root: string;
  /** Repo-relative directory to expand down to, e.g.
   *  `docs/projects/guest-checkout-v2`. */
  dir: string;
  /** Increments per request, so asking for the same folder twice is two
   *  requests: the consumer compares against the last `n` it served, which lets
   *  a request survive arriving while Files was still hidden without being
   *  replayed every time that view is shown again. */
  n: number;
};

let pending: FilesReveal | null = null;
const subs = new Set<() => void>();

export function subscribeFilesReveal(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function filesReveal(): FilesReveal | null { return pending; }

export function requestFilesReveal(root: string, dir: string): void {
  pending = { root, dir, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}
