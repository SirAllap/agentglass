// What each pull request's review notes add up to, for the board.
//
// ONE read per board load, for every card at once — never one per card. It is
// the server's own store (no GitHub request behind it), asked again only when
// the set of cards or one of their heads changes, or when the server says a
// plugin wrote notes on this repository (the `pr` frame the app already
// receives). Nothing here polls.

import { api } from "./api.ts";
import { subscribePluginFrame } from "./pluginBus.ts";
import type { PrNotesSummary } from "../../../shared/pluginUi.ts";

const byRepo = new Map<string, Map<number, PrNotesSummary>>();
const listeners = new Set<() => void>();
let version = 0;
const asked = new Map<string, Promise<void>>();

export const notesSummaryVersion = () => version;
export function onNotesSummary(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function summariesOf(repo: string | undefined): Map<number, PrNotesSummary> {
  return (repo && byRepo.get(repo)) || EMPTY;
}
const EMPTY = new Map<number, PrNotesSummary>();

/** Short heads are enough: the server compares by prefix, and a board of
 *  twenty should not put 800 characters of sha in a URL. */
export function headsOf(cards: { number: number; headSha?: string }[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of cards) if (c.headSha && c.headSha.length >= 7) out[c.number] = c.headSha.slice(0, 12);
  return out;
}

/** The same answer for the same question, in flight or just given: a board
 *  that re-renders must not turn into a request per render. */
export function loadNotesSummary(repo: string, heads: Record<number, string>, force = false): Promise<void> {
  const key = `${repo}|${Object.entries(heads).sort((a, b) => Number(a[0]) - Number(b[0])).map(([n, h]) => `${n}:${h}`).join(",")}`;
  const live = asked.get(key);
  if (live && !force) return live;
  const p = api.pluginPrNotesSummary(repo, heads).then((r) => {
    if (!r.ok) return;
    const m = new Map<number, PrNotesSummary>();
    for (const s of r.prs) m.set(s.number, s);
    byRepo.set(repo, m);
    version++;
    for (const l of listeners) l();
  }).catch(() => { /* no summary is no chips: the board is what it was */ }).finally(() => {
    // Remembered only while it is the answer: the next load asks again.
    if (asked.get(key) === p) asked.delete(key);
  });
  asked.set(key, p);
  return p;
}

/** Ask again when a plugin writes on this repository. Returns the way out. */
export function refreshOnNotes(repo: string, heads: () => Record<number, string>): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = subscribePluginFrame((f) => {
    if (f.kind !== "pr" || f.repo !== repo) return;
    // A plugin posting findings is many frames a second.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void loadNotesSummary(repo, heads(), true); }, 400);
  });
  return () => { off(); if (timer) clearTimeout(timer); };
}
