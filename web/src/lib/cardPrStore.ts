/*
 * The pull requests linked to a ClickUp card, read once per card and shared
 * across the row that draws the chip and the sidebar that opened first.
 *
 * `clickup/prs` searches GitHub by the card's own id and its `github` custom
 * field — there is no bulk endpoint, because the link is a text search over a
 * repository's pull requests, not a join ClickUp or GitHub keeps anywhere.
 * Asked per row on every render that would be a search per card per poll;
 * asked here it is one search per card, cached, and a board of thirty cards
 * left open for a session makes thirty of them total rather than thirty a
 * minute.
 *
 * The ceiling this accepts: a board scrolled into view for the first time
 * still pays one request per card the moment its row mounts — there is no
 * cheaper source for the card-to-pull-request link today. What this avoids is
 * asking again: `TTL_MS` matches `BOARD_POLL_MS`, the board's own refresh
 * interval, so a row re-rendered by that poll reuses its answer until it is
 * genuinely due for another one, instead of racing the poll with a timer of
 * its own.
 */
import { api } from "./api.ts";
import type { CardPr } from "./cardPrPick.ts";

/** Ten minutes, no longer the board's own poll interval (`BOARD_POLL_MS` in
 *  lib/boardPoll.ts). Each answer is a `gh pr list --search`, a GraphQL request
 *  against the account's 5000 an hour, and in step with a one-minute poll a
 *  board of thirty cards could spend thirty a minute on a link that changes
 *  once in a card's life. Ceiling: a pull request opened for a card shows on
 *  its row up to ten minutes late. */
export const TTL_MS = 10 * 60_000;
/** At once, matching prCardStore.ts: one ClickUp/GitHub token behind the
 *  server, and a board's worth of rows is a burst, not a stream. */
const AT_ONCE = 2;

type Entry = { at: number; prs: CardPr[]; error: boolean };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: { key: string; card: string; field: string; cwd: string }[] = [];
const listeners = new Set<() => void>();
let running = 0;
let version = 0;

function tell(): void { version++; for (const l of listeners) l(); }

/** Changes when any answer lands — the snapshot for `useSyncExternalStore`. */
export function cardPrVersion(): number { return version; }

export function onCardPrs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const { key, card, field, cwd } = waiting.shift()!;
    running++;
    inflight.add(key);
    api.clickupPrs(card, field, cwd, key)
      .then((r) => { seen.set(key, { at: Date.now(), prs: r.ok ? (r.prs ?? []) : [], error: !r.ok }); })
      .catch(() => { seen.set(key, { at: Date.now(), prs: [], error: true }); })
      .finally(() => { running--; inflight.delete(key); tell(); pump(); });
  }
}

/**
 * The pull requests for this card, or `null` while nobody has asked yet.
 *
 * Asking is the side effect, same as `prCardStore.cardOf`: calling this for a
 * card nothing has asked about queues it. A card with no `github` field, no
 * custom id and no task id worth searching on is not queued — there is nothing for
 * `clickup/prs` to search with, and a request that can only come back empty
 * is not a request worth making.
 */
export function cardPrsOf(taskId: string, card: string, field: string, cwd: string): Entry | null {
  const key = taskId;
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  // The task's own id is a search term too: a free workspace has no custom id,
  // and its branches say `CU-<task id>`.
  if (!card && !field && !taskId) return hit ?? null;
  if (!inflight.has(key) && !waiting.some((w) => w.key === key)) {
    waiting.push({ key, card, field, cwd });
    pump();
  }
  return hit ?? null;
}

/** Forget everything — a board switch or an explicit refresh, same trigger as
 *  `prCardStore.forgetCards`. */
export function forgetCardPrs(): void {
  seen.clear();
  waiting.length = 0;
  tell();
}
