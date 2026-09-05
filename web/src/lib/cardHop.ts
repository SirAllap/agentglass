// Moving to the next card without closing the one you are reading.
//
// The modal covers the table, so the only way from one card to the next was
// Escape, find the row again, click. On a board being triaged that is the whole
// job, done twice per card — and the modal exists precisely because the table
// was in the way.
//
// The order is the board's own, top to bottom, the same order the table draws:
// status groups in workflow order, priority first inside each. Nothing here
// re-sorts anything; it walks the list it is handed.

import type { ProviderTask } from "../../../shared/providers.ts";

/**
 * How much of a title the button carries.
 *
 * Long enough to tell two cards on the same board apart — they open "Billing |",
 * "T12 —", "GH —", so the first few words are the prefix everything shares —
 * and short enough that the control does not become the header. Measured
 * against the real titles on a board: 34 gets past the prefix on every one of
 * them and still fits beside its arrow at the width the modal has.
 */
export const HOP_TITLE_MAX = 34;

/** The title, cut to fit — at a word boundary when one is close enough, because
 *  a cut through the middle of a word reads as a rendering fault rather than as
 *  a deliberate shortening. */
export function shortTitle(s: string, max = HOP_TITLE_MAX): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space >= Math.floor(max * 0.6) ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface Hop {
  /** Where this card is in the list, 1-based. 0 when it is not in it at all. */
  i: number;
  n: number;
  prev: ProviderTask | null;
  next: ProviderTask | null;
}

/**
 * The card before and the card after, in the list's own order.
 *
 * No wrapping. The last card's "next" is nothing, and the button for it is
 * disabled: a nav that silently jumps from the bottom of the board back to the
 * top is a nav that loses your place, and the count beside it is what tells you
 * where the end is.
 *
 * A card that is not in the list — looked up by id, or on screen after the
 * board was refiltered underneath it — gets no neighbours rather than the
 * first two, and reports `i: 0` so the caller can say so.
 */
export function neighbours(list: readonly ProviderTask[], id: string): Hop {
  const at = list.findIndex((t) => t.id === id);
  if (at < 0) return { i: 0, n: list.length, prev: null, next: null };
  return {
    i: at + 1,
    n: list.length,
    prev: list[at - 1] ?? null,
    next: list[at + 1] ?? null,
  };
}

/** The picker's filter: the id somebody recognises, ClickUp's own, and the
 *  title. Same three things the board's search box matches, so a string that
 *  finds a row there finds it here. */
export function hopMatches(t: ProviderTask, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [t.customId ?? "", t.id, t.title].some((v) => v.toLowerCase().includes(needle));
}
