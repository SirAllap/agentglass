/*
 * What was seen of each Jira card and of each board, kept in this window (localStorage), one entry per site.
 *
 * Two copies, on purpose. The stored one moves on at once when a board or a card is opened. The BASELINE is what the
 * stored one said when this session first read the site, and it is what the marks are drawn against: otherwise
 * opening the board would wipe every mark in the same instant it drew them. Opening a card moves that card's baseline
 * alone, so its mark goes when the card is read. Nothing here asks Jira for anything.
 */
import { useEffect, useSyncExternalStore } from "react";
import { capSnaps, changedMap, siteOf, snapOf, type Change, type SeenCard, type Snap } from "./jiraChanged.ts";

interface Stored { board: number; cards: Record<string, Snap> }
const KEY = (site: string) => `agx.jira.seen.v1:${site}`;

const read = (site: string): Stored => {
  try {
    const raw = localStorage.getItem(KEY(site));
    const v = raw ? JSON.parse(raw) as Partial<Stored> : null;
    return { board: typeof v?.board === "number" ? v.board : 0, cards: v?.cards && typeof v.cards === "object" ? v.cards : {} };
  } catch { return { board: 0, cards: {} }; }
};
const write = (site: string, s: Stored) => { try { localStorage.setItem(KEY(site), JSON.stringify({ board: s.board, cards: capSnaps(s.cards) })); } catch { /* private mode: marks last this visit */ } };

const baseline = new Map<string, Stored>();
let changes = new Map<string, Change>();
let ids: ReadonlySet<string> = new Set();
let version = 0;
const subs = new Set<() => void>();
const bump = () => { version++; subs.forEach((f) => f()); };
const on = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** This session's view of one site: read once, then held. */
export function baselineOf(site: string): Stored {
  let b = baseline.get(site);
  if (!b) { b = read(site); baseline.set(site, b); }
  return b;
}

/** The board is open and its cards are loaded: work out what moved since last time, then say the board was seen now. */
export function boardLoaded(cards: readonly SeenCard[], key: (c: SeenCard) => string): void {
  const site = siteOf(cards.find((c) => c.url) ?? {});
  if (!site) return;
  const first = !baseline.has(site);
  const b = baselineOf(site);
  changes = changedMap(cards, b.cards, b.board, key);
  ids = new Set(changes.keys());
  if (first) {
    const s = read(site);
    const now = Date.now();
    for (const c of cards) s.cards[key(c)] = snapOf(c, now);
    s.board = now;
    write(site, s);
  }
  bump();
}

/**
 * Where an open card's "new" marks are drawn from, by card id. Opening the card moves its baseline to now (the board's
 * chip goes), so the card's own marks need the time it was last looked at BEFORE that: kept here until Mark read.
 */
const held = new Map<string, number>();

/** The card was opened: its mark goes now, and next session it is compared with how it stands today. */
export function cardSeen(c: SeenCard, key: string): void {
  const site = siteOf(c);
  if (!site) return;
  const snap = snapOf(c, Date.now());
  const prev = baselineOf(site).cards[key];
  /* Only a card that was flagged keeps its old time: opening the same card again must not wipe the marks being read. */
  if (prev && changes.has(c.id)) { held.set(c.id, prev.at); bump(); }
  baselineOf(site).cards[key] = snap;
  const s = read(site);
  s.cards[key] = snap;
  write(site, s);
  if (changes.delete(c.id)) { changes = new Map(changes); ids = new Set(changes.keys()); bump(); }
}

const snapshot = () => version;
/** The mark of one card, or null. Re-reads when a board loads or a card is opened. */
export function useChangeOf(id: string): Change | null {
  useSyncExternalStore(on, snapshot, snapshot);
  return changes.get(id) ?? null;
}
/** The ids of every changed card on the board now. */
export function useChangedIds(cards: readonly SeenCard[], key: (c: SeenCard) => string, active = true): ReadonlySet<string> {
  useSyncExternalStore(on, snapshot, snapshot);
  useEffect(() => { if (active && cards.length) boardLoaded(cards, key); }, [cards, key, active]);
  return ids;
}

/** The time the person last looked at this card, for drawing its new comments: 0 when never. Re-reads on open and on Mark read. */
export function useSince(c: SeenCard, key: string): number {
  useSyncExternalStore(on, snapshot, snapshot);
  return sinceOf(c, key);
}
export function sinceOf(c: SeenCard, key: string): number {
  const site = siteOf(c);
  return held.get(c.id) ?? (site ? baselineOf(site).cards[key]?.at ?? 0 : 0);
}

/** "Mark read": everything on this card up to now counts as read. */
export function markCardRead(c: SeenCard, key: string): void {
  cardSeen(c, key);
  held.set(c.id, Date.now());
  bump();
}

/** Only for tests: forget what an open card was held at. */
export function __resetHeld(): void { held.clear(); }
/** For tests: forget every stored snapshot and mark. */
export function __resetSeen(): void { baseline.clear(); changes = new Map(); ids = new Set(); held.clear(); }
