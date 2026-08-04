/*
 * "Show me that pull request."
 *
 * A ClickUp card knows its PR numbers; the pull-request view knows how to
 * display one. Neither is a parent of the other, and the panel asking is three
 * levels down from the one that owns the view. The same one-slot bus as
 * termIssue.ts and openSettings.ts, for the same reason: the sender does not
 * know whether the receiver is mounted, and should not have to.
 *
 * What travels is a SEARCH, not a selection — a number typed into the box that
 * view already has. That is deliberate: it is the gesture somebody performs by
 * hand today, it lands them somewhere they recognise, and it degrades honestly
 * when the PR is in another repository or has been deleted. Pushing a selection
 * instead would need the view to hold a card's idea of what exists.
 */
/**
 * How wide the receiving view has to look.
 *
 * `open` is the ordinary case and the cheap one. `all` includes every pull
 * request the repository has ever had — 16,199 of them on a real one against
 * 389 open — so it is asked for only when the thing being looked for is not
 * open, which the sender already knows from the card.
 */
export type PrScope = "open" | "all";

export interface PrJump { query: string; scope: PrScope; n: number }

let listener: ((j: PrJump) => void) | null = null;
let seq = 0;

export function onOpenPrs(fn: ((j: PrJump) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open the pull-request view looking for this. `n` rises each time so asking
 *  for the same number twice is two arrivals, not one ignored. */
export function openPrs(query: string, scope: PrScope = "open"): void {
  listener?.({ query, scope, n: ++seq });
}
