/*
 * The four questions the Jira board's filter sheet asks — text, assignee,
 * status, type — and nothing else. No JQL: a query string on a phone is a
 * second, worse way to say what a chip says, and the board's own saved filter
 * already lives on the computer.
 *
 * Filters narrow the cards already read, so every tick costs the site nothing.
 * Counts are live and each dimension is counted with the OTHER three applied:
 * "ana · 1" means ana has one card under the text, status and type already
 * chosen. A count that ignored its neighbours would promise cards the list
 * never shows, which is how a filter looks broken.
 *
 * Ceiling: one assignee at a time (a card has one on Jira), any number of
 * statuses and types, and text matches the key, the title and the labels — not
 * descriptions or comments, which the board read does not carry.
 */
import type { ProviderTask } from "../../../shared/providers.ts";

export type JiraAssignee = { kind: "person"; name: string } | { kind: "none" };

export interface JiraFilters {
  /** What is typed: any case, anywhere in the key, title or labels. */
  text: string;
  assignee: JiraAssignee | null;
  /** Status names as the site spells them; any of them. */
  statuses: string[];
  /** Issue types ("Story", "Bug"); any of them. */
  types: string[];
}

export const NO_JIRA_FILTERS: JiraFilters = { text: "", assignee: null, statuses: [], types: [] };

/** The person on a card, where the read named one. Jira has one assignee; the
 *  provider shape allows more, so the first is the one filters name. */
export function personOn(card: ProviderTask): string | null {
  const named = card.people?.find((p) => p.name)?.name;
  return named ?? card.assignees.find((n) => n.trim() !== "") ?? null;
}

const has = (list: readonly string[], value: string): boolean =>
  list.some((v) => v.trim().toLowerCase() === value.trim().toLowerCase());

/** Does this card get through these filters? Every answered question has to. */
export function matchesJira(card: ProviderTask, f: JiraFilters): boolean {
  const text = f.text.trim().toLowerCase();
  if (text) {
    const hay = [card.customId ?? card.id, card.title, ...(card.tags ?? [])].join("\n").toLowerCase();
    if (!text.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  if (f.assignee) {
    const who = personOn(card);
    if (f.assignee.kind === "none" ? who !== null : who === null || who.toLowerCase() !== f.assignee.name.toLowerCase()) return false;
  }
  if (f.statuses.length && !has(f.statuses, card.status)) return false;
  if (f.types.length && !has(f.types, card.issueType ?? "")) return false;
  return true;
}

export function applyJiraFilters(cards: readonly ProviderTask[], f: JiraFilters): ProviderTask[] {
  return cards.filter((c) => matchesJira(c, f));
}

/** How many questions are answered, for the button that opens the sheet. */
export function activeJiraFilters(f: JiraFilters): number {
  return (f.text.trim() ? 1 : 0) + (f.assignee ? 1 : 0) + f.statuses.length + f.types.length;
}

/** One answered question, as the chip above the board names and removes it. */
export interface JiraFilterChip { id: string; label: string }

/** The filters in force, one chip each: the board used to draw one sum, so
 *  dropping a status without the type meant opening the sheet again. */
export function activeJiraChips(f: JiraFilters): JiraFilterChip[] {
  const chips: JiraFilterChip[] = [];
  if (f.text.trim()) chips.push({ id: "text", label: `“${f.text.trim()}”` });
  if (f.assignee) {
    chips.push({ id: "assignee", label: f.assignee.kind === "none" ? "Unassigned" : f.assignee.name });
  }
  for (const s of f.statuses) chips.push({ id: `status:${s}`, label: s });
  for (const t of f.types) chips.push({ id: `type:${t}`, label: t });
  return chips;
}

/** The same filters with one chip's question unanswered; an unknown id is a no-op. */
export function removeJiraFilter(f: JiraFilters, id: string): JiraFilters {
  if (id === "text") return { ...f, text: "" };
  if (id === "assignee") return { ...f, assignee: null };
  if (id.startsWith("status:")) {
    const name = id.slice("status:".length);
    return { ...f, statuses: f.statuses.filter((s) => s !== name) };
  }
  if (id.startsWith("type:")) {
    const name = id.slice("type:".length);
    return { ...f, types: f.types.filter((t) => t !== name) };
  }
  return f;
}

export interface JiraFacet {
  /** The value a chip sets: a person's name, a status, a type. */
  name: string;
  count: number;
  /** Set on the connected account's own row, so the sheet can say "you". */
  me?: boolean;
}

export interface JiraFacets {
  assignees: JiraFacet[];
  statuses: JiraFacet[];
  types: JiraFacet[];
}

/** A card's assignee facets include an "Unassigned" row only when one exists. */
export function facetsOf(cards: readonly ProviderTask[], f: JiraFilters, statusOrder: readonly string[] = []): JiraFacets {
  const without = (drop: "assignee" | "statuses" | "types"): JiraFilters => ({ ...f, [drop]: drop === "assignee" ? null : [] });
  const people = new Map<string, JiraFacet>();
  for (const c of applyJiraFilters(cards, without("assignee"))) {
    const who = personOn(c);
    const name = who ?? "";
    const row = people.get(name) ?? { name, count: 0 };
    row.count += 1;
    if (c.mine) row.me = true;
    people.set(name, row);
  }
  const assignees = [...people.values()].sort((a, b) =>
    (a.name === "" ? 1 : 0) - (b.name === "" ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name));
  return {
    assignees,
    statuses: countBy(applyJiraFilters(cards, without("statuses")), (c) => c.status, statusOrder),
    types: countBy(applyJiraFilters(cards, without("types")), (c) => c.issueType ?? "", []),
  };
}

/** Values in a given order first (the view's statuses), then the rest by
 *  count; an empty value is never a chip. */
function countBy(cards: readonly ProviderTask[], key: (c: ProviderTask) => string, order: readonly string[]): JiraFacet[] {
  const by = new Map<string, number>();
  for (const c of cards) {
    const v = key(c).trim();
    if (v) by.set(v, (by.get(v) ?? 0) + 1);
  }
  const rank = (v: string): number => {
    const i = order.findIndex((o) => o.trim().toLowerCase() === v.toLowerCase());
    return i < 0 ? order.length : i;
  };
  return [...by.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name));
}
