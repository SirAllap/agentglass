/*
 * A card changed on one screen, and the list on another hears about it.
 *
 * The card screen moves a card and re-reads it; the Cards tab behind it keeps
 * the row it fetched when it opened. Go back and the row still says the old
 * column, until a pull-to-refresh — which is what the audit found, and which
 * reads as "the move did not take" to somebody who just watched it take.
 *
 * Two ways to fix that and this is the cheaper one. Re-reading the view on
 * every focus costs a request per tab switch against a workspace API with a
 * rate budget, for a list that changed by one row. Passing the row itself
 * costs nothing: every write route already answers with the card as it
 * stands after the write (`WriteOutcome.task`, re-read rather than assumed),
 * so the card screen has the exact object the list needs.
 *
 * A module-level set of listeners rather than context, for the reason
 * use-tracks-work.ts gives for its cache: the two screens are in different
 * navigators and share no ancestor short of the root, and a context at the
 * root re-renders the app to move one row.
 */
import { useEffect } from "react";
import type { ProviderTask } from "../../../shared/providers.ts";

type Listener = (task: ProviderTask) => void;
const listeners = new Set<Listener>();

/** Said by a screen that just wrote to a card and was handed it back. */
export function announceCard(task: ProviderTask): void {
  for (const listen of listeners) listen(task);
}

/** Heard by a screen holding a list the card might be in. Returns the
 *  unsubscribe, for the effect that calls it. */
export function onCardChanged(listen: Listener): () => void {
  listeners.add(listen);
  return () => { listeners.delete(listen); };
}

/** `onCardChanged` for a component's lifetime. `listen` is a dependency, so
 *  hand it a stable function (a `useCallback`) or it resubscribes per render. */
export function useCardChanges(listen: Listener): void {
  useEffect(() => onCardChanged(listen), [listen]);
}

/**
 * The list with the card's new self in the old one's place.
 *
 * Unchanged — the same array — when the card is not in it: a card moved on a
 * view this list is not showing is not this list's business, and returning a
 * copy would re-render a screen for nothing. `null` (not loaded yet) stays
 * `null`; the load that is in flight will bring the current row.
 */
export function withCard(list: ProviderTask[] | null, task: ProviderTask): ProviderTask[] | null {
  if (!list) return list;
  const at = list.findIndex((t) => t.id === task.id);
  if (at < 0) return list;
  const next = list.slice();
  next[at] = task;
  return next;
}
