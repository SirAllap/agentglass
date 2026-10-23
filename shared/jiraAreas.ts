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

/** A rail row's title: the whole name minus its "[EPIC]" tag, never cut (the row wraps it to two lines). */
export const railTitle = (name: string): string => areaName(name);

/** What an empty table says: an epic's words when one is selected, the board's otherwise. */
export const emptyBodyText = (epicSelected: boolean): string => epicSelected ? "This epic has no cards in the read." : "This board has nothing open.";

/** "area": an "Area: …" epic (or, on a board with none, an epic that holds a card). "epic": another epic still open. */
export interface AreaRow { key: string; name: string; color?: string; total: number; inSprint: number; done: number; group: "area" | "epic" }

const isArea = (e: JiraBoardEpic): boolean => /^area\s*:/i.test(e.name);
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** How many open epics that are not areas the rail and the kept read take. A QA epic with a hundred runs is done and is not one of them. */
export const OPEN_EPICS_MAX = 10;

/** The open epics beside the areas: not named "Area: …", not done, the first OPEN_EPICS_MAX in the order the board gives them. */
export const openEpics = (epics: readonly JiraBoardEpic[]): JiraBoardEpic[] => epics.filter((e) => !isArea(e) && e.done !== true).slice(0, OPEN_EPICS_MAX);

/**
 * The `parent` clause of the kept read: the area epics plus the open ones beside them. Where no epic is named
 * "Area: …", every card under any epic (the tree then draws the epics that hold one).
 */
export function underClause(epics: readonly JiraBoardEpic[]): string {
  const keys = [...epics.filter(isArea), ...openEpics(epics)].map((e) => e.key).filter((k) => KEY.test(k));
  return epics.some(isArea) && keys.length ? `parent in (${keys.join(", ")})` : "parent is not EMPTY";
}

/**
 * One row per area. The areas are the epics named "Area: …" when the board has any, and after them the open epics
 * beside them (group "epic", at most OPEN_EPICS_MAX; a done one is history and is left out). Else every epic that holds
 * a card (a board whose epics are not areas still gets a tree). Counts are over the cards the read holds, done ones included.
 * An area with no card is still a row: an empty area is an answer.
 *
 * `fresh` is the sprint's own read, asked every time the board loads, where `tasks` is the one read kept for ten
 * minutes: a card moved into the sprint since then is in the first and not yet in the second, and "0 in Sprint 1" was
 * what the header said for an epic whose child was in Sprint 1 (measured: the kept read itself counts it, so the count
 * was the age of the read, not the field). A card in either, once, in the sprint, counts.
 */
export function areaRows(epics: readonly JiraBoardEpic[], tasks: readonly ProviderTask[], sprintName: string | undefined, fresh: readonly ProviderTask[] = []): AreaRow[] {
  const named = epics.filter(isArea);
  const held = new Map<string, ProviderTask[]>();
  for (const t of tasks) if (t.parent) (held.get(t.parent.key) ?? held.set(t.parent.key, []).get(t.parent.key)!).push(t);
  const pool = named.length ? [...named, ...openEpics(epics)] : epics.filter((e) => held.has(e.key));
  return pool.map((e) => {
    const list = held.get(e.key) ?? [];
    const inS = sprintName ? inSprint(e.key, list, fresh, sprintName) : 0;
    return {
      key: e.key, name: areaName(e.name), group: !named.length || isArea(e) ? "area" as const : "epic" as const, ...(e.color ? { color: e.color } : {}),
      total: new Set([...list, ...fresh.filter((t) => t.parent?.key === e.key)].map((t) => t.id)).size, inSprint: inS, done: list.filter((t) => t.statusKind === "done").length,
    };
  });
}


function inSprint(key: string, held: readonly ProviderTask[], fresh: readonly ProviderTask[], sprintName: string): number {
  const ids = new Set<string>();
  for (const t of [...held, ...fresh]) if (t.parent?.key === key && t.sprint === sprintName) ids.add(t.id);
  return ids.size;
}

/**
 * What a rail row's count says: how many cards are still open of how many it holds. `lead` is the open number in the
 * normal weight, `rest` the quiet remainder; a finished row (open 0) is a check and the total only. A truncated read
 * counts "at least". Ceiling: open is total - done over the cards held, so it is as old as the kept read.
 */
export function countCell(a: Pick<AreaRow, "total" | "done">, truncated: boolean): { done: boolean; lead: string; rest: string; title: string } {
  const open = Math.max(0, a.total - a.done);
  const total = truncated ? `at least ${a.total}` : `${a.total}`;
  const title = `${open} open of ${total}; ${a.done} done`;
  // No card held: the epic is unknown or empty, and a check says "everything is done".
  if (a.total === 0) return { done: false, lead: "0", rest: "", title: "no cards read" };
  return open === 0 ? { done: true, lead: "✓", rest: ` ${a.total}`, title } : { done: false, lead: `${open}`, rest: ` / ${a.total}`, title };
}

/**
 * The three chips of an epic's header: what is open, what is done, what is in the active sprint. Same counts as the
 * line it replaces; a truncated read says "at least" on the sprint chip's total. `sprint` is null where no sprint is active.
 */
export function headChips(a: Pick<AreaRow, "total" | "done" | "inSprint">, sprintName: string | undefined, truncated: boolean): { open: string; done: string; sprint: string | null } {
  return {
    open: `${Math.max(0, a.total - a.done)} open`,
    done: `${a.done} done`,
    sprint: sprintName ? `${a.inSprint} in ${sprintName} of ${truncated ? "at least " : ""}${a.total}` : null,
  };
}
