/*
 * The card a pull request came from, read once and shared.
 *
 * Two places want it now — the sidebar, which shows where the card stands, and
 * the reviewer menu, which moves it — and the lookup is a call through the
 * server to ClickUp. Asked per component it would be one request per pull
 * request per surface, repeated on every poll of the panel; asked here it is
 * one, and the second reader is free.
 *
 * Keyed by the card reference rather than by the pull request, because that is
 * what the answer depends on: two pull requests against the same card are one
 * lookup.
 */
import { api } from "./api.ts";
import { taskLink } from "./taskLink.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import type { PrSummary } from "../../../shared/types.ts";

/** Long enough that moving between tabs does not re-ask, short enough that a
 *  card somebody moved on the board stops claiming its old status. */
const TTL_MS = 60_000;
/**
 * How old a reading may be before a row is worth replacing with a live one.
 *
 * The server's copy comes off a board cached on disk and is accepted up to a
 * day old, which is far too generous for a field people move several times a
 * morning: measured on a row 24 minutes old, the board drew "in development"
 * on him while the tracker had it in "code review" on somebody else, and no
 * amount of pressing Refresh changed it — Refresh re-reads the pull requests,
 * not the tracker.
 *
 * Longer than TTL_MS on purpose. A whole board of rows re-asking on the
 * store's own TTL is twenty lookups a minute for a view somebody leaves open;
 * at five minutes it is four, and a status nobody has touched in five minutes
 * is not the one that misleads.
 */
const FRESH_ENOUGH_MS = 5 * 60_000;
/** At once. The server holds one ClickUp token and the sidebar is a glance. */
const AT_ONCE = 2;

type Entry = { at: number; task: ProviderTask | null; error: string };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: string[] = [];
const listeners = new Set<() => void>();
let running = 0;

let version = 0;

function tell(): void { version++; for (const l of listeners) l(); }

/** Changes when any answer lands — the snapshot for `useSyncExternalStore`,
 *  which needs a value it can compare rather than a fresh object. */
export function cardVersion(): number { return version; }

function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const query = waiting.shift()!;
    running++;
    inflight.add(query);
    api.clickupFind(query)
      .then((r) => {
        seen.set(query, {
          at: Date.now(),
          task: r?.ok && r.task ? r.task : null,
          error: r?.ok && r.task ? "" : (r?.error || "ClickUp could not find it"),
        });
      })
      // A failure is remembered too, as "no answer" — otherwise every render
      // queues the same doomed request again.
      .catch(() => { seen.set(query, { at: Date.now(), task: null, error: "Could not reach the server" }); })
      .finally(() => { running--; inflight.delete(query); tell(); pump(); });
  }
}

/** Subscribe to answers landing. Returns the unsubscribe. */
export function onCard(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The card, or null while nobody knows.
 *
 * Asking is the side effect: calling this for a reference nothing has asked
 * about yet puts it in the queue. The thing that knows a card is on screen is
 * the thing drawing it.
 */
export function cardOf(query: string, maxAgeMs: number = TTL_MS): Entry | null {
  if (!query) return null;
  const hit = seen.get(query);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit;
  if (!inflight.has(query) && !waiting.includes(query)) {
    waiting.push(query);
    pump();
  }
  return hit ?? null;
}

/** Nobody has an answer for this one yet — told apart from "no card", which
 *  draws nothing rather than a space kept for one. */
export function askingCard(query: string): boolean {
  if (!query) return false;
  const hit = seen.get(query);
  return !hit || Date.now() - hit.at >= TTL_MS;
}

/**
 * Throw one away — after the picker moves the card, where the status we are
 * holding is exactly the thing that just stopped being true.
 */
export function forgetCard(query: string): void {
  if (!query) return;
  seen.delete(query);
  tell();
}

/**
 * Forget everything, and say so.
 *
 * Refresh means "ask again for what is in front of me", and this is the one
 * reading it could not shift: the cards are held here rather than on the
 * server, so re-asking the server returned the same rows carrying the same
 * card. Telling the listeners is the half that makes it visible — without it
 * nothing re-renders, so nothing calls `cardOf`, so nothing is re-read.
 */
export function forgetCards(): void {
  seen.clear();
  waiting.length = 0;
  tell();
}

/**
 * The row carrying the card the SCREEN is showing.
 *
 * `p.card` is filled by the server from the boards already cached on disk, and
 * only from ones read in the last day — so on a machine whose boards were last
 * read a week ago it is absent from every row, and the chip on screen comes
 * from the lookup above instead. Anything that reads `p.card` directly is then
 * blind to a card that is in plain sight: a filter on card status matched
 * nothing at all, silently, which reads as a filter that does not work.
 *
 * Asking is the side effect of `cardOf`, so this must only be called for rows
 * something is already drawing — the board's two dozen, never the table's four
 * hundred.
 */
export function withCard<T extends PrSummary>(p: T, hasTaskProvider: boolean): T {
  const t = taskLink(p, hasTaskProvider);
  if (!t) return p;
  /* A reading young enough to stand behind is left alone — that is the free
     path, and most rows take it. Everything else asks, and keeps what it has
     until an answer arrives: a stale status is worse than a fresh one and
     better than none. */
  const mine = p.card;
  if (mine?.at && Date.now() - mine.at < FRESH_ENOUGH_MS) return p;
  const hit = cardOf(t.query, FRESH_ENOUGH_MS);
  const k = hit?.task;
  if (!k) return p;
  return {
    ...p,
    card: {
      id: k.id, customId: k.customId, title: k.title, url: k.url,
      status: k.status, statusColor: k.statusColor, statusKind: k.statusKind,
      priority: k.priority,
      people: k.people?.slice(0, 3),
      /* Read just now, by definition: this path IS the fresh read. */
      at: hit.at,
    },
  };
}
