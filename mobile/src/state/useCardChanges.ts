/*
 * The React half of card-edits, on its own so the other half stays loadable.
 *
 * `card-edits.ts` is list arithmetic and a set of listeners — no dependency, no
 * install needed to run its tests. One `useEffect` import used to sit in it,
 * and that was enough to make the whole module fail to load in any checkout
 * without `mobile/node_modules`: `Cannot find package 'react'`, in a suite
 * whose real answer was "npm has not run here". The hook is the only part that
 * needs React, so the hook is the part that moved.
 */
import { useEffect } from "react";
import { onCardChanged, type Listener } from "./card-edits.ts";

/** `onCardChanged` for a component's lifetime. `listen` is a dependency, so
 *  hand it a stable function (a `useCallback`) or it resubscribes per render. */
export function useCardChanges(listen: Listener): void {
  useEffect(() => onCardChanged(listen), [listen]);
}
