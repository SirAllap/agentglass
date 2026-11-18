/*
 * The Epics and Components sections of the Filters menu as plain data: which choices the cards on screen offer, and how a
 * pick narrows them. This is a filter ON TOP of any view; the sidebar's own epic or component (areaId) still picks the
 * view itself, and both apply together.
 *
 * An epic is read as the epic swimlanes read it (boardModel `epicOf`: a sub-task sits in its parent's epic),
 * and a component only where the read asked for components, so a card without them offers none.
 */
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { epicOf } from "./boardModel.ts";

export interface FacetChoice { id: string; name: string; count: number; on: boolean }

/** The epic a card sits under: the board's own `epicOf` (a sub-task wears its parent's epic), named for a choice row. */
const epicNamed = (t: ProviderTask, cards: readonly ProviderTask[]): { key: string; name: string } | undefined => {
  const e = epicOf(t, cards);
  return e ? { key: e.key, name: e.title || e.key } : undefined;
};

function tally(entries: Iterable<[string, string]>, picked: readonly string[]): FacetChoice[] {
  const rows = new Map<string, FacetChoice>();
  for (const id of picked) rows.set(id, { id, name: id, count: 0, on: true });
  for (const [id, name] of entries) {
    const r = rows.get(id);
    if (r) { r.count += 1; if (r.name === r.id) r.name = name; } else rows.set(id, { id, name, count: 1, on: false });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The epics the cards on screen sit under, with how many cards each holds; a picked epic with none left still shows, at 0. */
export function epicChoices(cards: readonly ProviderTask[], picked: readonly string[]): FacetChoice[] {
  return tally(cards.flatMap((t) => { const e = epicNamed(t, cards); return e ? [[e.key, e.name] as [string, string]] : []; }), picked);
}

/** The components the cards on screen are filed under, with counts; a card in two components counts in both. */
export function componentChoices(cards: readonly ProviderTask[], picked: readonly string[]): FacetChoice[] {
  return tally(cards.flatMap((t) => (t.components ?? []).map((c) => [c, c] as [string, string])), picked);
}

/** The priorities a card can carry, in the order the site ranks them; "none" is a card with no priority. */
export const PRIORITY_LABEL: Readonly<Record<string, string>> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low", none: "No priority" };
export function priorityChoices(cards: readonly ProviderTask[], picked: readonly string[]): FacetChoice[] {
  return Object.entries(PRIORITY_LABEL).map(([id, name]) => ({ id, name, count: cards.filter((t) => (t.priority ?? "none") === id).length, on: picked.includes(id) }));
}

/** Whether a card passes the epic and component picks: any picked epic, and any picked component; an empty pick passes all. */
export function passesEpicComponent(t: ProviderTask, epicPick: readonly string[], componentPick: readonly string[], cards: readonly ProviderTask[] = []): boolean {
  if (epicPick.length && !epicPick.includes(epicNamed(t, cards)?.key ?? "")) return false;
  if (componentPick.length && !(t.components ?? []).some((c) => componentPick.includes(c))) return false;
  return true;
}

/** The chip: "Epic: Auth hardening" for one, "Epics: 2" for several. `names` maps an epic key to its title. */
export const epicChipLabel = (picked: readonly string[], names: Readonly<Record<string, string>> = {}): string =>
  picked.length === 1 ? `Epic: ${names[picked[0]!] ?? picked[0]}` : `Epics: ${picked.length}`;
export const componentChipLabel = (picked: readonly string[]): string =>
  picked.length === 1 ? `Component: ${picked[0]}` : `Components: ${picked.length}`;

/** Epic key to title over the cards on screen, for the chip. */
export function epicNamesOf(cards: readonly ProviderTask[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of cards) { const e = epicNamed(t, cards); if (e) out[e.key] = e.name; }
  return out;
}

/** The key of the epic a card sits under, or "" when none. */
export const epicKeyOf = (t: ProviderTask, cards: readonly ProviderTask[]): string => epicNamed(t, cards)?.key ?? "";
