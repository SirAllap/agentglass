/*
 * The card behind each pull request row, one lookup table per paired computer.
 *
 * The rules (what is free, what costs a ClickUp request, how many at once) are
 * in model/cardLookup.ts; this wires them to the computer and to React.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import { chipFor, readTaskRef } from "../../../shared/taskref.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { createCardLookups, type CardLookups } from "../model/cardLookup.ts";
import { cardState, type CardState } from "../model/prCard.ts";

const byComputer = new Map<string, CardLookups>();

/** One table per computer: two paired computers can hold the same id for
 *  different cards. Keyed by origin AND token: the table's reads close over the
 *  host it was made for, so after a re-pair (same origin, new token) a table
 *  keyed by origin alone went on asking with the token the computer revoked. */
export function lookupsFor(host: Host): CardLookups {
  const key = `${host.origin}\n${host.token}`;
  let l = byComputer.get(key);
  if (!l) {
    l = createCardLookups({
      async where(id) {
        const a = await ask<{ ok: boolean; task?: ProviderTask }>(host, `/clickup/where?id=${encodeURIComponent(id)}`);
        return a.ok && a.value.ok && a.value.task ? a.value.task : null;
      },
      async find(id) {
        const a = await ask<{ ok: boolean; task?: ProviderTask; error?: string }>(host, `/clickup/find?q=${encodeURIComponent(id)}`);
        return a.ok ? { task: a.value.ok ? a.value.task : null, error: a.value.error } : { error: a.error };
      },
    });
    byComputer.set(key, l);
  }
  return l;
}

/** Forget what was learned about cards, so the next paint asks again. */
export function forgetPrCards(host: Host | null): void { if (host) lookupsFor(host).clear(); }

/**
 * What a row says about its card, and the one function that spends a request.
 *
 * `tracked` is "is a tracker connected" (null while unknown). A row naming no
 * card, or a computer with no tracker, is `none` and asks nothing.
 */
export function usePrCard(host: Host, pr: PrSummary, tracked: boolean | null): { state: CardState; find: () => void } {
  const lookups = lookupsFor(host);
  const query = useMemo(() => {
    if (pr.card || tracked === false) return null;
    const go = chipFor(readTaskRef(pr), tracked === null ? true : tracked);
    return go && "find" in go ? go.find : null;
  }, [pr, tracked]);
  /* This row's own answer is the snapshot — the same object until that id
     changes — so twenty rows do not all repaint each time one lookup lands. */
  const looked = useSyncExternalStore(lookups.subscribe, () => (query ? lookups.peek(query) : null));
  // `looked === null` is also what a refresh leaves behind, which asks again.
  useEffect(() => { if (query && tracked) lookups.where(query); }, [lookups, query, tracked, looked === null]);
  return {
    state: cardState(pr, query, tracked === null ? { phase: "where" } : looked),
    find: () => { if (query) lookups.find(query); },
  };
}
