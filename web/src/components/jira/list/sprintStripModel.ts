/*
 * The sprint strip of a JQL or cross-space view: which running sprints the cards on screen belong to, and the numbers
 * beside each. A pure function, because there is no renderer in this project.
 *
 * Read-only on purpose. Starting or completing a sprint is not here: it writes to the site and wants its own
 * confirmation, and is the next thing after this, not a gap that was missed.
 *
 * The dates come from the board context's sprint (`known`) when it is that sprint, else from the sprint field the
 * card itself carries (`sprintStart`, `sprintEnd`): no second read. A sprint whose cards carry neither is drawn with
 * its numbers and no days.
 */
import type { JiraBoardSprint, ProviderTask } from "../../../../../shared/providers.ts";
import { sprintLine } from "../../../lib/jiraBoardContext.ts";

export const MAX_SPRINTS = 3;

export interface SprintEntry {
  id: string;
  name: string;
  /** "6 days left", "ends today", "2 days over"; empty when the dates are not known. */
  left: string;
  late: boolean;
  done: number;
  total: number;
  /** Story points of the cards that carry some; null when none does. */
  points: { done: number; total: number } | null;
  goal: string;
}

export interface SprintStrip { entries: SprintEntry[]; more: number }

/** The sprint line says "ended 2 days ago"; on a strip that reads as "2 days over". */
const overOf = (left: string): string => { const m = /^ended (\d+) days ago$/.exec(left); return m ? `${m[1]} days over` : left === "ended yesterday" ? "1 day over" : left; };

export function sprintStrip(o: { cards: readonly ProviderTask[]; known: JiraBoardSprint | undefined; on: boolean; now: number }): SprintStrip {
  if (!o.on) return { entries: [], more: 0 };
  const by = new Map<string, { name: string; first: number; cards: ProviderTask[] }>();
  o.cards.forEach((t, i) => {
    if (!t.sprintActive || !t.sprint) return;
    const id = t.sprintId ?? t.sprint;
    const s = by.get(id) ?? { name: t.sprint, first: i, cards: [] };
    s.cards.push(t);
    by.set(id, s);
  });
  const all = [...by.entries()].sort((a, b) => b[1].cards.length - a[1].cards.length || a[1].first - b[1].first).map(([id, s]): SprintEntry => {
    const own = s.cards.find((t) => t.sprintEnd && t.sprintStart);
    const from: Pick<JiraBoardSprint, "start" | "end" | "goal"> | undefined = o.known && (o.known.id === id || o.known.name === s.name) ? o.known : own ? { start: own.sprintStart!, end: own.sprintEnd!, ...(own.sprintGoal ? { goal: own.sprintGoal } : {}) } : undefined;
    const dated = from ? sprintLine({ id, name: s.name, state: "active", ...from }, o.now) : null;
    const pointed = s.cards.filter((t) => typeof t.points === "number");
    const sum = (rows: readonly ProviderTask[]) => rows.reduce((n, t) => n + (t.points ?? 0), 0);
    return {
      id, name: s.name, left: dated ? overOf(dated.left) : "", late: dated?.late ?? false,
      done: s.cards.filter((t) => t.statusKind === "done").length, total: s.cards.length,
      points: pointed.length ? { done: sum(pointed.filter((t) => t.statusKind === "done")), total: sum(pointed) } : null,
      goal: from?.goal ?? "",
    };
  });
  return { entries: all.slice(0, MAX_SPRINTS), more: Math.max(0, all.length - MAX_SPRINTS) };
}

/** One entry as a line: "ORBIT S4 · 6 days left · 7/12 cards · 21/40 pts". */
export const entryText = (e: SprintEntry): string =>
  [e.name, e.left, `${e.done}/${e.total} cards`, e.points ? `${e.points.done}/${e.points.total} points` : ""].filter(Boolean).join(" · ");
