/*
 * The card behind each pull request row, one lookup table per paired computer
 * and per tracker.
 *
 * The rules (what is free, what costs a request, how many at once) are in
 * model/cardLookup.ts; this wires them to the computer and to React. Which
 * tracker is asked is model/cardDoor.ts, and it is a Jira key before it is a
 * ClickUp id: rule 1 of the Jira-first switch.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import { readTaskRef, type JiraReach } from "../../../shared/taskref.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { createCardLookups, type CardLookups } from "../model/cardLookup.ts";
import { cardDoor } from "../model/cardDoor.ts";
import { cardFresh, cardState, reaskDoor, type CardState } from "../model/prCard.ts";

type Tracker = "clickup" | "jira";

const byComputer = new Map<string, CardLookups>();

/** One table per computer AND tracker: two paired computers can hold the same
 *  id for different cards, and a Jira key is not a ClickUp id even when the
 *  strings match. Keyed by origin and token because the table's reads close
 *  over the host they were made for: after a re-pair (same origin, new token) a
 *  table keyed by origin alone went on asking with the token the computer
 *  revoked. */
export function lookupsFor(host: Host, tracker: Tracker = "clickup"): CardLookups {
  const key = `${host.origin}\n${host.token}\n${tracker}`;
  let l = byComputer.get(key);
  if (!l) {
    l = createCardLookups(tracker === "jira" ? jiraIo(host) : clickupIo(host), tracker);
    byComputer.set(key, l);
  }
  return l;
}

function clickupIo(host: Host) {
  return {
    async where(id: string) {
      const a = await ask<{ ok: boolean; task?: ProviderTask }>(host, `/clickup/where?id=${encodeURIComponent(id)}`);
      return a.ok && a.value.ok && a.value.task ? a.value.task : null;
    },
    async find(id: string) {
      const a = await ask<{ ok: boolean; task?: ProviderTask; error?: string }>(host, `/clickup/find?q=${encodeURIComponent(id)}`);
      return a.ok ? { task: a.value.ok ? a.value.task : null, error: a.value.error } : { error: a.error };
    },
  };
}

function jiraIo(host: Host) {
  return {
    /* No route answers "is this card on a board I have" for Jira without
       asking Jira, so the free half answers "not that we know of" and the one
       request stays the person's to make — the same price ClickUp's charge. */
    async where() { return null; },
    async find(id: string) {
      const a = await ask<{ ok: boolean; task?: ProviderTask; error?: string }>(host, `/jira/find?q=${encodeURIComponent(id)}`);
      return a.ok ? { task: a.value.ok ? a.value.task : null, error: a.value.error } : { error: a.error };
    },
  };
}

/** Forget what was learned about cards, so the next paint asks again. */
export function forgetPrCards(host: Host | null): void {
  if (!host) return;
  const prefix = `${host.origin}\n${host.token}\n`;
  for (const [key, l] of byComputer) if (key.startsWith(prefix)) l.clear();
}

/**
 * What a row says about its card, and the one function that spends a request.
 *
 * `tracked` is "is a tracker connected" (null while unknown); `jira` is what
 * the connected site says its project keys are, or null. A row naming no card,
 * or a computer with no tracker, is `none` and asks nothing.
 *
 * A row already carrying a card is free while that copy is young. Older than
 * five minutes it is re-asked of the tracker, because the server fills it from a
 * board cached on disk and accepts a day-old one: a card moved this morning drew
 * its old status all day. A Jira card is the exception — never re-asked, as on
 * the desk. The row's copy is drawn until the answer lands.
 */
export function usePrCard(
  host: Host, pr: PrSummary, tracked: boolean | null, jira?: JiraReach | null,
): { state: CardState; find: () => void } {
  const stale = !!pr.card && !cardFresh(pr.card, Date.now());
  const door = useMemo(() => {
    if (tracked === false) return null;
    /* A row already carrying a card is re-asked of the tracker that card came
       from, under its own id — except a Jira one, which is read from the
       server's views and never re-asked. See reaskDoor. */
    if (pr.card) return reaskDoor(pr.card);
    const ref = readTaskRef(pr, jira ?? undefined);
    // A reference with an address opens it; nothing has to be looked up.
    if (!ref || ref.url) return null;
    return cardDoor(ref, { clickup: true, jira });
  }, [pr, tracked, jira]);
  const lookups = lookupsFor(host, door?.tracker ?? "clickup");
  const query = door?.id ?? null;
  /* This row's own answer is the snapshot — the same object until that id
     changes — so twenty rows do not all repaint each time one lookup lands. */
  const looked = useSyncExternalStore(lookups.subscribe, () => (query ? lookups.peek(query) : null));
  // `looked === null` is also what a refresh leaves behind, which asks again.
  useEffect(() => {
    if (!query || !tracked) return;
    if (stale) { lookups.refresh(query); return; }
    lookups.where(query);
  }, [lookups, query, tracked, stale, looked === null]);
  return {
    state: cardState(pr, query, tracked === null ? { phase: "where" } : looked, Date.now()),
    find: () => { if (query) lookups.find(query); },
  };
}
