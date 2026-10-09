/*
 * The card list's search, filters and sections, apart from the screen.
 *
 * Every question here is answered from the cards already loaded. A board read
 * is one request per page and the tracker's budget is per token, so typing in
 * the search box or ticking a status must not spend any: the screen reads the
 * board once and narrows what it holds. The ceiling is the board read's own —
 * a board that stopped at its page limit is narrowed at that limit, and the
 * sheet says so rather than implying it searched the workspace. Workspace
 * search is left out on purpose for the same reason.
 *
 * Values inside one facet are OR-ed and facets are AND-ed, as the desk's and
 * the pull request filters' are (model/prFilters.ts).
 */
import type { ListStatus, ProviderTask } from "../../../shared/providers.ts";
import { matchesQuery } from "../../../shared/taskref.ts";

/** The pieces of a card that narrowing and sections read — what a fixture has
 *  to supply, and a `ProviderTask` already is. */
export type BoardCard = Pick<ProviderTask, "id" | "title" | "status" | "statusKind"> & Partial<Pick<
  ProviderTask, "customId" | "list" | "people" | "assignees" | "statusColor" | "custom"
>>;

/** The key of "nobody is on it" in `CardFilters.people`. ClickUp ids are
 *  numbers, so this cannot be one. */
export const UNASSIGNED = "none";

export interface CardFilters {
  /** Status names as the workspace spells them, OR-ed. */
  statuses: string[];
  /** `personKey`s, OR-ed, with `UNASSIGNED` for a card nobody is on. */
  people: string[];
  /** Section headers by status, like the desk's board. Not a narrowing. */
  group: boolean;
}

export const NO_CARD_FILTERS: CardFilters = { statuses: [], people: [], group: true };

type Person = NonNullable<ProviderTask["people"]>[number];

/** Identity is the id: a board here has two people who share initials, and a
 *  picker that matched by name would eventually choose the wrong one. A card
 *  that only carries names (older reads) is matched by the name. */
export const personKey = (p: Pick<Person, "id" | "name">): string => (p.id != null ? String(p.id) : p.name);

/** Who is on a card, as people. */
export function peopleOf(c: Pick<BoardCard, "people" | "assignees">): Person[] {
  if (c.people?.length) return c.people;
  return (c.assignees ?? []).map((name) => ({ name, initials: "" }));
}

/** Whether the search box's words are all somewhere in the card. An empty box
 *  keeps everything — the shared matcher's "matches nothing" is for a caller
 *  that was handed an id, which is not this. */
export function searchMatches(c: BoardCard, q: string): boolean {
  if (!q.trim()) return true;
  return matchesQuery([c.title, c.customId, c.id, c.list, c.status, ...peopleOf(c).map((p) => p.name)], q);
}

export function matchesFacets(c: BoardCard, f: Pick<CardFilters, "statuses" | "people">): boolean {
  if (f.statuses.length && !f.statuses.includes(c.status)) return false;
  if (f.people.length) {
    const on = peopleOf(c);
    const hit = on.length ? on.some((p) => f.people.includes(personKey(p))) : f.people.includes(UNASSIGNED);
    if (!hit) return false;
  }
  return true;
}

const isOpen = (c: BoardCard): boolean => c.statusKind !== "done";

/** What the list draws: the search, the facets, then Open or All. */
export function narrowed<T extends BoardCard>(cards: readonly T[], q: string, f: CardFilters, openOnly: boolean): T[] {
  return cards.filter((c) => searchMatches(c, q) && matchesFacets(c, f) && (!openOnly || isOpen(c)));
}

/** The cards the sheet's options are counted over: the search and Open/All, but
 *  not the facets — a count that shrank as you ticked would be a moving target. */
export const scopeCards = <T extends BoardCard>(cards: readonly T[], q: string, openOnly: boolean): T[] =>
  narrowed(cards, q, NO_CARD_FILTERS, openOnly);

/** What the list shows and the two numbers on the Open / All control (what
 *  each would show), from one pass over the cards. */
export function openAllView<T extends BoardCard>(
  cards: readonly T[], q: string, f: CardFilters, openOnly: boolean,
): { shown: T[]; counts: { open: number; all: number } } {
  const all = narrowed(cards, q, f, false);
  const open = all.filter(isOpen);
  return { shown: openOnly ? open : all, counts: { open: open.length, all: all.length } };
}

/**
 * A board read cut off at the server's limit: every number drawn from it is a
 * floor, so the counts say "12+" and one quiet line says why. Not cut off, no
 * line and plain numbers.
 */
export const boardCount = (n: number, truncated: boolean): number | string => (truncated ? `${n}+` : n);
export const truncatedNote = (read: number, truncated: boolean): string | null =>
  truncated ? `Showing the first ${read} cards; narrow the board to see the rest.` : null;

/** "Show N cards": the draft filters over the same search and Open/All. */
export const shownCount = (cards: readonly BoardCard[], draft: CardFilters, q: string, openOnly: boolean): number =>
  narrowed(cards, q, draft, openOnly).length;

/** How many facets narrow the list, for the badge on the filter button. */
export const activeFacets = (f: CardFilters): number => (f.statuses.length ? 1 : 0) + (f.people.length ? 1 : 0);

export interface StatusOption { status: string; color?: string; count: number }

/**
 * The checklist's rows: each status a card in scope carries, in the list's own
 * order (not alphabetical: "Blocked" above "To Do" is nobody's workflow), then
 * any the list does not name in the order they were met. A status already
 * ticked stays listed at zero so it can be un-ticked.
 */
export function statusOptions(scope: readonly BoardCard[], order: readonly ListStatus[], keep: readonly string[] = []): StatusOption[] {
  const seen = new Map<string, StatusOption>();
  for (const c of scope) {
    const at = seen.get(c.status) ?? { status: c.status, color: c.statusColor, count: 0 };
    at.count++;
    seen.set(c.status, at);
  }
  for (const k of keep) if (!seen.has(k)) seen.set(k, { status: k, count: 0 });
  const rank = new Map([...order].sort((a, b) => a.orderindex - b.orderindex).map((s, i) => [s.status, i] as const));
  const colour = new Map(order.map((s) => [s.status, s.color] as const));
  return [...seen.values()]
    .map((o, i) => ({ o, at: rank.get(o.status) ?? order.length + i }))
    .sort((a, b) => a.at - b.at)
    .map(({ o }) => ({ ...o, color: colour.get(o.status) ?? o.color }));
}

export interface PersonOption {
  key: string;
  /** "Me" for the connected account, otherwise their name. */
  name: string;
  /** Under "Me": who that is. */
  sub?: string;
  avatar?: string;
  color?: string;
  initials?: string;
  me: boolean;
  count: number;
}

/**
 * The people list: everybody on a card of the board, me first under my own
 * word, then most cards first. Counted over the cards in scope; `all` supplies
 * the names of a person picked earlier who has no card in scope any more.
 * Unassigned is counted apart because it is not a person and is drawn last.
 */
export function personOptions(
  scope: readonly BoardCard[], keep: readonly string[] = [], all: readonly BoardCard[] = scope,
): { people: PersonOption[]; unassigned: number } {
  const seen = new Map<string, PersonOption>();
  let unassigned = 0;
  const add = (p: Person, n: number): void => {
    const key = personKey(p);
    const at = seen.get(key) ?? {
      key, name: p.me ? "Me" : p.name, sub: p.me ? p.name : undefined, avatar: p.avatar, color: p.color,
      initials: p.initials || undefined, me: !!p.me, count: 0,
    };
    at.count += n;
    seen.set(key, at);
  };
  for (const c of scope) {
    const on = peopleOf(c);
    if (!on.length) unassigned++;
    for (const p of on) add(p, 1);
  }
  for (const c of all) for (const p of peopleOf(c)) if (keep.includes(personKey(p))) add(p, 0);
  const people = [...seen.values()].sort((a, b) =>
    Number(b.me) - Number(a.me) || b.count - a.count || a.name.localeCompare(b.name));
  return { people, unassigned };
}

export interface CardSection<T extends BoardCard = BoardCard> {
  key: string;
  /** The status as spelled, or null when grouping is off. */
  label: string | null;
  color?: string;
  cards: T[];
}

/**
 * The list's sections. Grouped: one per status present, in the list's order
 * (then any the list does not name, as met). Not grouped: one with no header,
 * in the order the board gave.
 */
export function cardSections<T extends BoardCard>(cards: readonly T[], order: readonly ListStatus[], group: boolean): CardSection<T>[] {
  if (!group) return [{ key: "all", label: null, cards: [...cards] }];
  const by = new Map<string, { color?: string; cards: T[] }>();
  for (const c of cards) {
    const at = by.get(c.status) ?? { color: c.statusColor, cards: [] };
    at.cards.push(c);
    by.set(c.status, at);
  }
  const rank = new Map([...order].sort((a, b) => a.orderindex - b.orderindex).map((s, i) => [s.status, i] as const));
  const colour = new Map(order.map((s) => [s.status, s.color] as const));
  return [...by.entries()]
    .map(([status, v], i) => ({ status, v, at: rank.get(status) ?? order.length + i }))
    .sort((a, b) => a.at - b.at)
    .map(({ status, v }) => ({ key: status, label: status, color: colour.get(status) ?? v.color, cards: v.cards }));
}

export type BoardItem<T extends BoardCard = BoardCard> =
  | { kind: "head"; key: string; section: CardSection<T> }
  | { kind: "card"; key: string; card: T; last: boolean };

/** One flat list for the FlatList: a header, then its cards. */
export function flatItems<T extends BoardCard>(sections: readonly CardSection<T>[]): BoardItem<T>[] {
  const out: BoardItem<T>[] = [];
  for (const s of sections) {
    if (s.label !== null) out.push({ kind: "head", key: `h:${s.key}`, section: s });
    s.cards.forEach((card, i) => out.push({ kind: "card", key: card.id, card, last: i === s.cards.length - 1 }));
  }
  return out;
}

export type EmptyWhy = "none" | "search" | "filters" | "all-done";

/** Why a list is empty, most specific first: what somebody typed, then what
 *  they ticked, then "everything here is finished" — and only then nothing. */
export function whyEmpty(cards: readonly BoardCard[], q: string, f: CardFilters, openOnly: boolean): EmptyWhy | null {
  if (narrowed(cards, q, f, openOnly).length) return null;
  if (!cards.length) return "none";
  if (q.trim()) return "search";
  if (activeFacets(f)) return "filters";
  return openOnly ? "all-done" : "none";
}

/** The field shows `github.com/acme/orbit/pull/101` and keeps the address in
 *  `href`, so the scheme is optional and both are read. */
const PR_URL = /(?:https?:\/\/)?github\.com\/[^\s/,]+\/[^\s/,]+\/pull\/\d+/gi;

/**
 * How many pull requests a card has, without asking.
 *
 * `learned` is what the phone already found out by reading the card
 * (state/card-links.ts). Without it the card's own GitHub field is the only
 * free source: it names the pull requests somebody linked by hand. Finding the
 * rest is a GitHub search per card (`/clickup/prs`), which a list of forty must
 * not start, so a card nobody opened shows no number rather than a guessed
 * zero. `null` is "not known", never "none".
 */
export function prCount(card: Pick<BoardCard, "custom">, learned: number | undefined): number | null {
  if (learned !== undefined) return learned;
  const field = card.custom?.find((c) => /github/i.test(c.name));
  const text = `${field?.value ?? ""} ${field?.href ?? ""}`;
  const urls = new Set((text.match(PR_URL) ?? []).map((u) => u.toLowerCase().replace(/^https?:\/\//, "")));
  return urls.size ? urls.size : null;
}
