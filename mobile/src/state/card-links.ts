/*
 * How many pull requests each card turned out to have, as far as this phone
 * has found out.
 *
 * Finding a card's pull requests is a GitHub search (`/clickup/prs`), so a list
 * of forty cards cannot ask for them. What the list shows instead is what is
 * already known: the card's own GitHub field (model/cardBoard.ts `prCount`) and,
 * from here, the answer a card screen read when somebody opened it. Nothing in
 * this file makes a request.
 */
import { useSyncExternalStore } from "react";
import type { Host } from "../lib/host.ts";
import { cardKey } from "./card-cache.ts";

const learned = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

/** Called by the card screen when it has read the card's pull requests. */
export function noteCardPrs(host: Host, cardId: string, count: number): void {
  if (learned.get(cardKey(host.origin, cardId)) === count) return;
  learned.set(cardKey(host.origin, cardId), count);
  version++;
  for (const l of listeners) l();
}

/** What was learned for each card, repainting the reader when it changes. */
export function useLearnedCardPrs(host: Host | null): (cardId: string) => number | undefined {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);
  return (id) => (host ? learned.get(cardKey(host.origin, id)) : undefined);
}
