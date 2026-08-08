/*
 * "Show me that card."
 *
 * The mirror of openPrs.ts, and it exists for the same reason. That one takes
 * you from a ClickUp card to the pull request it produced; this one takes you
 * back — from the pull request masthead to the card it came from, in the Tasks
 * view, with its description and its status where you can read them.
 *
 * The sender is the pull-request panel and the receiver is the ClickUp board,
 * two views that never meet: the workspace mounts a view the first time you go
 * to it, so at the moment the chip is pressed the board may not exist yet. So
 * the request is left in a slot, the shell switches views, and the board serves
 * it once it has something to serve it from.
 *
 * What travels is what the pull request KNEW — an id and the words to put on
 * screen while it is looked up — not a card. The pull request has never seen
 * the card; claiming otherwise would mean inventing a row for one that has been
 * deleted, moved, or is in a workspace this token cannot read.
 */

export interface CardJump {
  /** The id to look for: ClickUp's internal one, or the human `ORBIT-1042`.
   *  Both are things the finder already accepts. */
  query: string;
  /** What the chip said, for the board to name it by while it is finding it —
   *  and in the sentence it writes when it cannot. */
  label: string;
  /** Rises per request, so asking for the same card twice is two arrivals
   *  rather than one that looks already served. */
  n: number;
}

let listener: ((j: CardJump) => void) | null = null;
let seq = 0;

export function onOpenCard(fn: ((j: CardJump) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open the Tasks view on this ClickUp card. */
export function openCard(query: string, label?: string): void {
  listener?.({ query, label: label || query, n: ++seq });
}
