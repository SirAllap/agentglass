/*
 * What an area is, for the Areas tree and for the agent door to a board: the epics named "Area: …" with how many cards
 * each holds. One definition, so the screen and an agent read the same numbers.
 */
import type { JiraBoardEpic, ProviderTask } from "./providers.ts";

/** An area epic is named "Area: Mobile" on the site; the tree shows "Mobile". A leading "[EPIC]" tag is not part of the name either. */
export const areaName = (name: string): string => name.replace(/^\[epic\]\s*/i, "").replace(/^area\s*:\s*/i, "").trim() || name;

const LABEL_MAX = 28;
/**
 * An epic's name as a row in a narrow rail reads it: cut at the first " (" (a title there carries its detail in
 * brackets: "Design system (tokens, components, …)") or at LABEL_MAX characters with an ellipsis. The whole name is the
 * tooltip. Ceiling: a name with no " (" and no space is cut mid-word.
 */
export function epicLabel(name: string): string {
  const full = areaName(name);
  const paren = full.indexOf(" (");
  const head = (paren > 0 ? full.slice(0, paren) : full).trim();
  return head.length > LABEL_MAX ? `${head.slice(0, LABEL_MAX - 1).trimEnd()}…` : head;
}

export interface AreaRow { key: string; name: string; color?: string; total: number; inSprint: number; done: number }

/**
 * One row per area. The areas are the epics named "Area: …" when the board has any, else every epic that holds a card
 * (a board whose epics are not areas still gets a tree). Counts are over the cards the read holds, done ones included.
 * An area with no card is still a row: an empty area is an answer.
 *
 * `fresh` is the sprint's own read, asked every time the board loads, where `tasks` is the one read kept for ten
 * minutes: a card moved into the sprint since then is in the first and not yet in the second, and "0 in Sprint 1" was
 * what the header said for an epic whose child was in Sprint 1 (measured: the kept read itself counts it, so the count
 * was the age of the read, not the field). A card in either, once, in the sprint, counts.
 */
export function areaRows(epics: readonly JiraBoardEpic[], tasks: readonly ProviderTask[], sprintName: string | undefined, fresh: readonly ProviderTask[] = []): AreaRow[] {
  const named = epics.filter((e) => /^area\s*:/i.test(e.name));
  const held = new Map<string, ProviderTask[]>();
  for (const t of tasks) if (t.parent) (held.get(t.parent.key) ?? held.set(t.parent.key, []).get(t.parent.key)!).push(t);
  const pool = named.length ? named : epics.filter((e) => held.has(e.key));
  return pool.map((e) => {
    const list = held.get(e.key) ?? [];
    const inS = sprintName ? inSprint(e.key, list, fresh, sprintName) : 0;
    return {
      key: e.key, name: areaName(e.name), ...(e.color ? { color: e.color } : {}),
      total: new Set([...list, ...fresh.filter((t) => t.parent?.key === e.key)].map((t) => t.id)).size, inSprint: inS, done: list.filter((t) => t.statusKind === "done").length,
    };
  });
}


function inSprint(key: string, held: readonly ProviderTask[], fresh: readonly ProviderTask[], sprintName: string): number {
  const ids = new Set<string>();
  for (const t of [...held, ...fresh]) if (t.parent?.key === key && t.sprint === sprintName) ids.add(t.id);
  return ids.size;
}
