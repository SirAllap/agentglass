// Where a card's Review cell goes, as one decision rather than as three
// conditions in the markup: a review a person gave is in the Conversation under
// "All", a bot's is under "Bots", and a review that was only asked for is not a
// review yet — the cell has nothing to open and must not pretend otherwise.
import type { CardReviewers } from "./cardReviewers.ts";

/**
 * `lane` is which side of the Conversation to show; `node` is the review's own
 * row inside it, so the press lands on the review rather than on the top of a
 * long page. `node` is absent when the server that answered predates the field
 * — the press then lands on the lane, as it did before.
 */
export interface ReviewTarget {
  lane: "all" | "bot";
  node?: string;
}

/**
 * `r` is what the card already drew (see `cardReviewers`), so this reads the
 * state the card shows instead of a sentence. "Re-review requested" counts: a
 * review was given and a push has sent it back. `ids` is the address of each
 * side's review — the one the cell is about, not merely the newest of them.
 * Ceiling: only `await` is inert, so a state added to `ReviewPerson` later
 * opens the Conversation rather than silently losing the cell.
 */
export function reviewTarget(
  r: CardReviewers,
  bot: boolean | undefined,
  ids: { human?: string; bot?: string } = {},
): ReviewTarget | null {
  if ([...r.faces, ...r.more].some((f) => f.state !== "await")) return { lane: "all", ...(ids.human ? { node: ids.human } : null) };
  return bot ? { lane: "bot", ...(ids.bot ? { node: ids.bot } : null) } : null;
}
