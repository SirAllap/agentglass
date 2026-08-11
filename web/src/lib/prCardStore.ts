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
import type { ProviderTask } from "../../../shared/providers.ts";

/** Long enough that moving between tabs does not re-ask, short enough that a
 *  card somebody moved on the board stops claiming its old status. */
const TTL_MS = 60_000;
/** At once. The server holds one ClickUp token and the sidebar is a glance. */
const AT_ONCE = 2;

type Entry = { at: number; task: ProviderTask | null; error: string };

const seen = new Map<string, Entry>();
const inflight = new Set<string>();
const waiting: string[] = [];
const listeners = new Set<() => void>();
let running = 0;

function tell(): void { for (const l of listeners) l(); }

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
export function cardOf(query: string): Entry | null {
  if (!query) return null;
  const hit = seen.get(query);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
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

/** Forget everything — for a test. */
export function forgetCards(): void {
  seen.clear();
  waiting.length = 0;
}
