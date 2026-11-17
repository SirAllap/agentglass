/*
 * The compact board header as plain data: how many filters the Filters button counts, the right-hand "14 of 45 · 31 hidden",
 * and the chips line (the view's JQL, the board's own scope, then one removable chip each). Nothing here reads the screen.
 */
import { activeChips, type ActiveChip } from "./viewsModel.ts";
import type { JiraListFilters } from "./model.ts";
import { EMPTY } from "../../tasks/filters.ts";

/** The quick toggles at the foot of the Filters popover; each is a boolean on the list's filters. */
export const QUICK_TOGGLES = [
  { id: "flaggedOnly", label: "Flagged" },
  { id: "blockedOnly", label: "Blocked" },
  { id: "dueOnly", label: "Has due date" },
  { id: "quietOnly", label: "Quiet 14 days" },
  { id: "liveOnly", label: "Live worker" },
  { id: "needsOnly", label: "Needs you" },
] as const;
export type QuickToggle = (typeof QUICK_TOGGLES)[number]["id"];

/** What the badge on the Filters button counts: one per picked space, person, status, label, toggle and rule. Hide done is not counted: it is the default the chip row shows, not something the person picked. */
export function filterCount(f: JiraListFilters): number {
  return (f.spaces?.length ?? 0) + f.assigneePick.length + f.statusPick.length + f.tagPick.length
    + f.epicPick.length + f.componentPick.length
    + QUICK_TOGGLES.filter((q) => !!f[q.id]).length + f.quick.length + f.built.rules.length + (f.sprintOnly ? 1 : 0) + (f.sprintPick?.length ?? 0) + (f.priorityPick?.length ?? 0) + Object.values(f.notPick ?? {}).reduce((a, l) => a + l.length, 0) + (f.showDone ? 1 : 0);
}


/** "14 of 45 · 31 hidden": the cards shown, of all the board holds; the hidden part is left off when nothing is hidden. */
export function countLine(shown: number, total: number, truncated: boolean): { head: string; hidden: string | null } {
  const hidden = Math.max(0, total - shown);
  return { head: `${shown} of ${total}${truncated ? "+" : ""}`, hidden: hidden > 0 ? `${hidden} hidden` : null };
}

/** The count as one string, "14 of 45 · 31 hidden · 3 changed": the board's single count, shown in the footer only. */
export function countText(count: { head: string; hidden: string | null }, changed?: string | null): string {
  return [count.head, count.hidden, changed].filter(Boolean).join(" · ");
}

/** A tab's count is worth a glance only above 0: "Orbit bugs 0" is a number that says nothing the empty board does not. Unknown ("—") stays. */
export function showTabCount(c: { n: number } | "err" | undefined): boolean {
  return !!c && (c === "err" || c.n > 0);
}

export interface ChipsLine {
  /** The line shows only when something is applied. The default "Hide done" alone is not something the person applied. */
  show: boolean;
  jql: string | null;
  board: ActiveChip | null;
  chips: ActiveChip[];
}

export function chipsLine(f: JiraListFilters, boardName: string | undefined, quickNames: Readonly<Record<string, string>> = {}, epicNames: Readonly<Record<string, string>> = {}): ChipsLine {
  const all = activeChips(f, boardName, quickNames, epicNames);
  const jql = f.viewJql?.trim() || null;
  const chips = all.filter((c) => !c.board && c.id !== "view");
  return { show: !!jql || chips.some((c) => c.id !== "done"), jql, board: all.find((c) => c.board) ?? null, chips };
}

/** Editing a view's JQL in the box: the sentence under the row, and whether "Save to view" is on offer. */
export function editCaption(name: string, shown: number, total: number): string {
  return `Editing the JQL of “${name}”. Count stays ${shown} of ${total} until saved.`;
}

/** The popover's own "Clear all": its facets off. The search, the view's JQL and Hide done are not its to clear. */
export const FACETS_OFF: Partial<JiraListFilters> = {
  spaces: [], assigneePick: [], statusPick: [], tagPick: [], epicPick: [], componentPick: [], flaggedOnly: false, blockedOnly: false, dueOnly: false, liveOnly: false, needsOnly: false, quietOnly: false, sprintOnly: null, sprintPick: [], priorityPick: [], notPick: {}, tagAll: false, quick: [], built: { ...EMPTY },
};

/**
 * Which rows of one Filters section are drawn. A search shows every row whose label holds it (case-insensitive) and
 * nothing else; without one, a long section shows its first `limit` rows plus every picked row, so a pick never hides
 * behind "Show more". `more` is how many rows the collapsed section leaves out (0 while searching or opened).
 * The ceiling: a plain substring match, so "dev" finds "In development" but no fuzzy or initials match.
 */
export function facetRows<T extends { label: string; on: boolean }>(rows: readonly T[], query: string, opened: boolean, limit = 6): { rows: T[]; more: number } {
  const q = query.trim().toLowerCase();
  if (q) return { rows: rows.filter((r) => r.label.toLowerCase().includes(q)), more: 0 };
  if (opened || rows.length <= limit) return { rows: [...rows], more: 0 };
  const shown = rows.filter((r, i) => i < limit || r.on);
  return { rows: shown, more: rows.length - shown.length };
}
