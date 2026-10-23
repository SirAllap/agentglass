/*
 * The decisions a Jira board makes about its context, apart from any screen so
 * each can be asserted without a renderer: how cards group under their parent,
 * how a sprint's dates read, what colour an epic wears, which drops are a rank
 * and what the card's order becomes the moment it is dropped.
 *
 * Ceilings, on purpose: one level of parent (a sub-task sits under its story,
 * not under the epic above it: the row's own parent is the only one a board
 * read carries); a sprint is a line, not a burndown; an epic's colour is one of
 * a dozen house tones picked by Jira's colour number, not Jira's own palette.
 */
import type { JiraBoardSprint, ProviderTask } from "../../../shared/providers.ts";
import { compareOrder } from "../../../shared/orderIndex.ts";

export type GroupMode = "status" | "parent";

/** A board is grouped by status unless the person chose otherwise and the source has parents to group by. */
export const groupModeOf = (saved: string | null | undefined, available: boolean): GroupMode => (available && saved === "parent" ? "parent" : "status");

export interface ParentGroup {
  /** The parent's card key; "" for the cards that have none. */
  key: string;
  title: string;
  /** What the parent is on the site ("Epic", "Story"). */
  type?: string;
  rows: ProviderTask[];
  done: number;
}

/**
 * The cards under each parent. Parents come in the order their first card does, which on a rank-ordered board is the
 * order the person ranked them in; the cards with no parent are one group, last. A card keeps the order it arrived in.
 */
export function groupByParent(rows: readonly ProviderTask[]): ParentGroup[] {
  const by = new Map<string, ParentGroup>();
  const bare: ProviderTask[] = [];
  for (const t of rows) {
    if (!t.parent) { bare.push(t); continue; }
    const g = by.get(t.parent.key) ?? by.set(t.parent.key, { key: t.parent.key, title: t.parent.title, ...(t.parent.type ? { type: t.parent.type } : {}), rows: [], done: 0 }).get(t.parent.key)!;
    g.rows.push(t);
    if (t.statusKind === "done") g.done++;
  }
  const out = [...by.values()];
  if (bare.length) out.push({ key: "", title: "No parent", rows: bare, done: bare.filter((t) => t.statusKind === "done").length });
  return out;
}

/** Jira's epic colours are `color_1`..`color_14` (and `dark_` variants); the house has a handful of tones, taken by number. */
const EPIC_TONES = ["--primary", "--success", "--warning", "--error", "--text2"] as const;
export function epicTone(color: string | undefined): string {
  const n = Number(/(\d{1,2})$/.exec(color ?? "")?.[1]);
  return Number.isFinite(n) && n > 0 ? EPIC_TONES[(n - 1) % EPIC_TONES.length]! : "--text3";
}

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (ms: number): string => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

/** The header's line for the sprint: its dates and where in them today is. Empty text where the site gave no dates. */
export function sprintLine(s: JiraBoardSprint, now: number): { range: string; left: string; late: boolean } {
  if (!s.start || !s.end) return { range: "", left: "", late: false };
  // Whole days, counted by calendar day in UTC so the same sprint reads the same on every machine.
  const endDay = Math.floor(s.end / DAY);
  const days = endDay - Math.floor(now / DAY);
  const left = days > 1 ? `${days} days left` : days === 1 ? "1 day left" : days === 0 ? "ends today" : days === -1 ? "ended yesterday" : `ended ${-days} days ago`;
  return { range: `${dayOf(s.start)} – ${dayOf(s.end)}`, left, late: days < 0 };
}

export interface RankAsk { before?: string; after?: string }

/**
 * What a drop asks of Jira: the card that was picked up and the card it was dropped on, from the half of the target the
 * pointer was in. Null when it is no change: the card dropped on itself, or into the slot it already holds. `keys` is the
 * group's cards in the order drawn, so "dropped on the top half of the card below me" is the place I already hold.
 */
export function rankOf(keys: readonly string[], from: string, target: string, half: "top" | "bottom"): { key: string; ask: RankAsk } | null {
  const at = keys.indexOf(from);
  const to = keys.indexOf(target);
  if (at < 0 || to < 0 || from === target) return null;
  // Before the card below me, or after the card above me, is where I already am.
  if (half === "top" && to === at + 1) return null;
  if (half === "bottom" && to === at - 1) return null;
  return { key: from, ask: half === "top" ? { before: target } : { after: target } };
}

/**
 * The order the dropped card sorts at until the board is read again: half a step either side of its neighbour, which
 * `compareOrder` reads as the decimal it is. Null when the neighbour has no order (a board not ordered by rank).
 */
export function guessOrder(neighbour: string | undefined, half: "top" | "bottom"): string | null {
  const n = neighbour === undefined || neighbour === "" ? NaN : Number(neighbour);
  return Number.isFinite(n) ? String(half === "top" ? n - 0.5 : n + 0.5) : null;
}

/** Whether a group's cards can be dragged: the site orders them by rank, so each carries a place to be put against. */
export const rankable = (rows: readonly ProviderTask[]): boolean => rows.length > 1 && rows.every((t) => t.order !== undefined);

/** The cards of a group in drawn order, for the tests of what a guessed order does to the sort. */
export const sortedByOrder = (rows: readonly ProviderTask[]): ProviderTask[] => [...rows].sort((a, b) => compareOrder(a.order, b.order));
