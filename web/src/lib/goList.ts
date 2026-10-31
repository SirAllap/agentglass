/*
 * The Go list under the project chip, as data: what needs you first, then the
 * project you are in, then the others — each with the switch that keeps it in
 * the strip. A blocked window is listed once, under "Needs you", not again under
 * its project. The arrow keys and Enter work over `rows`, the same list in the
 * order it is drawn.
 */
import type { TmuxWindow } from "../../../shared/types.ts";
import type { TabGroup } from "./tabGroups.ts";

export interface GoRow {
  window: TmuxWindow;
  /** The project's name as drawn. */
  project: string;
  projectKey: string;
  branch: string;
  /** The Alt+N the strip gives this window, or null when it is not on the strip. */
  number: number | null;
}

export interface GoSection {
  key: string;
  label: string;
  /** Every window in the project, matched or not. */
  count: number;
  /** Only meaningful for the other projects. */
  kept: boolean;
  rows: GoRow[];
}

export interface GoInput {
  groups: readonly TabGroup[];
  current: string | null;
  kept: ReadonlySet<string>;
  query: string;
  /** Window id to its branch; tmux does not report one, the caller knows. */
  branches?: ReadonlyMap<string, string>;
  /** Window id to its Alt/prefix number, from `stripZones`. */
  numbers?: ReadonlyMap<string, number>;
}

export interface GoList {
  needsYou: GoRow[];
  here: GoSection | null;
  others: GoSection[];
  /** needsYou, here, others: the order they are drawn and the arrows walk. */
  rows: GoRow[];
}

export function goList({ groups, current, kept, query, branches, numbers }: GoInput): GoList {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const row = (g: TabGroup, window: TmuxWindow): GoRow => ({
    window, project: g.label, projectKey: g.key, branch: branches?.get(window.id) ?? "", number: numbers?.get(window.id) ?? null,
  });
  const hit = (r: GoRow) => {
    const hay = `${r.window.name} ${r.project} ${r.branch}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const here = groups.find((g) => g.key === current) ?? groups[0];
  const needsYou = groups.flatMap((g) => g.windows.filter((w) => w.status === "waiting").map((w) => row(g, w))).filter(hit);
  const section = (g: TabGroup): GoSection | null => {
    const rows = g.windows.filter((w) => w.status !== "waiting").map((w) => row(g, w)).filter(hit);
    return rows.length ? { key: g.key, label: g.label, count: g.windows.length, kept: kept.has(g.key), rows } : null;
  };
  const hereSection = here ? section(here) : null;
  const others = groups.filter((g) => g !== here).flatMap((g) => section(g) ?? []);
  return { needsYou, here: hereSection, others, rows: [...needsYou, ...(hereSection?.rows ?? []), ...others.flatMap((s) => s.rows)] };
}

/** ArrowUp/ArrowDown over `count` rows, wrapping; -1 (nothing selected) goes
 *  to the first row down and the last row up. An empty list selects nothing. */
export function moveSelection(index: number, key: "ArrowUp" | "ArrowDown", count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return key === "ArrowDown" ? 0 : count - 1;
  return (index + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** What Enter opens. */
export function pickRow(rows: readonly GoRow[], index: number): GoRow | null {
  return rows[index] ?? null;
}
