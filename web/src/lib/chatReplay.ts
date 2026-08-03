// Reconciling a replayed transcript with what the panel already had on screen.
//
// The transcript is the truth. It is what the CLI actually wrote, and the pane
// can be attached to see the same thing — so when the two disagree, the local
// copy is what gives way.

/** Only what this needs: replayed entries and local ones are different shapes
 *  either side of this function, and both carry a millisecond timestamp. */
type Stamped = { ts: number };

/**
 * The replayed transcript, plus anything local it does not already cover.
 *
 * Prepending the replay to the local messages wholesale is what put every turn
 * on screen twice after a restart: the panel persists its own copy of a
 * conversation, the transcript replay brings the same turns back, and both were
 * kept. Attaching to the pane showed the prompt exactly once, which is how it
 * was clear the duplicate was ours rather than the CLI's.
 *
 * A local message survives only if it is newer than everything replayed — which
 * is precisely the case the old code was reaching for: something typed while
 * the replay was in flight must stay, and must stay last. Everything at or
 * before the cut is a copy of a turn the transcript already has.
 */
export function mergeReplayed<R extends Stamped, L extends Stamped>(replayed: R[], local: L[]): (R | L)[] {
  if (!replayed.length) return [...local];
  const cut = replayed[replayed.length - 1]!.ts;
  return [...replayed, ...local.filter((m) => m.ts > cut)];
}
