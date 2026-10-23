/*
 * What an area is, for the Areas tree and for the agent door to a board: the epics named "Area: …" with how many cards
 * each holds. One definition, so the screen and an agent read the same numbers.
 */
import type { JiraBoardEpic, ProviderTask } from "./providers.ts";

/** An area epic is named "Area: Mobile" on the site; the tree shows "Mobile". */
export const areaName = (name: string): string => name.replace(/^area\s*:\s*/i, "").trim() || name;

export interface AreaRow { key: string; name: string; color?: string; total: number; inSprint: number; done: number }

/**
 * One row per area. The areas are the epics named "Area: …" when the board has any, else every epic that holds a card
 * (a board whose epics are not areas still gets a tree). Counts are over the cards the read holds, done ones included.
 * An area with no card is still a row: an empty area is an answer.
 */
export function areaRows(epics: readonly JiraBoardEpic[], tasks: readonly ProviderTask[], sprintName: string | undefined): AreaRow[] {
  const named = epics.filter((e) => /^area\s*:/i.test(e.name));
  const held = new Map<string, ProviderTask[]>();
  for (const t of tasks) if (t.parent) (held.get(t.parent.key) ?? held.set(t.parent.key, []).get(t.parent.key)!).push(t);
  const pool = named.length ? named : epics.filter((e) => held.has(e.key));
  return pool.map((e) => {
    const list = held.get(e.key) ?? [];
    return {
      key: e.key, name: areaName(e.name), ...(e.color ? { color: e.color } : {}),
      total: list.length, inSprint: sprintName ? list.filter((t) => t.sprint === sprintName).length : 0, done: list.filter((t) => t.statusKind === "done").length,
    };
  });
}

