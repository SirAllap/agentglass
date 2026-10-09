/*
 * What this screen already knows about a card, so it does not ask ClickUp again.
 *
 * ClickUp limits a token to about a hundred requests a minute and the person
 * shares that token with their real work. Opening one card was measured at six
 * of them (the task, its time in status, its comments, one per thread of
 * replies, the list's statuses and its fields) — sixteen openings spend the
 * minute — and every write then re-read the whole card for three more.
 *
 * Two holds, both stale-while-revalidate: what is held is drawn at once, and is
 * only asked for again when it is older than its freshness. A card's own row
 * goes stale in a minute (somebody else can move it); a list's statuses almost
 * never change, so ten. Keyed by the computer and the id, because two paired
 * computers can hold the same id for different cards.
 */
import type { ListMember, TaskDetail } from "../../../shared/providers.ts";

export const CARD_FRESH_MS = 60_000;
export const LIST_FRESH_MS = 10 * 60_000;
/** Enough for a day of opening cards; the oldest goes first. */
const KEEP = 40;

interface Held<T> { at: number; value: T }

export interface Hold<T> {
  get(key: string): Held<T> | null;
  put(key: string, value: T, now?: number): void;
  /** Is there something for this key younger than `ttl`? */
  fresh(key: string, ttl: number, now?: number): boolean;
  drop(key: string): void;
  clear(): void;
}

function hold<T>(): Hold<T> {
  const held = new Map<string, Held<T>>();
  return {
    get: (key) => held.get(key) ?? null,
    put(key, value, now = Date.now()) {
      held.delete(key); // re-inserted last, so the oldest is the first key
      held.set(key, { at: now, value });
      if (held.size > KEEP) held.delete(held.keys().next().value as string);
    },
    fresh(key, ttl, now = Date.now()) {
      const h = held.get(key);
      return !!h && now - h.at < ttl;
    },
    drop: (key) => { held.delete(key); },
    clear: () => held.clear(),
  };
}

export const cards = hold<TaskDetail>();
export const lists = hold<{ status: string; color?: string; type?: string }[]>();
/** Whether the computer lets ClickUp be written to, by computer. Held as long
 *  as a card: the owner flips it at the desk and a lock that outlives that by
 *  ten minutes reads as a fault. */
export const writes = hold<boolean>();

/** Who can be put on a card of a list, by computer and list. Held as long as
 *  a list's statuses: a team changes rarely, and each read costs two requests. */
export const members = hold<ListMember[]>();

export const cardKey = (origin: string, id: string): string => `${origin}\u0000${id}`;
