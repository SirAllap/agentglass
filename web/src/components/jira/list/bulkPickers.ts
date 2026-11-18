/*
 * What the bulk bar's menus offer, decided with no renderer: the sprints (from the same board context the card menu
 * reads), the statuses as coloured pills, the priorities as flags, and the people as the card's own picker rows.
 */
import type { JiraBoardContext, JiraPerson, ListMember, ListStatus } from "../../../../../shared/providers.ts";
import type { SelectOption } from "../../Select.tsx";
import { priorityInk } from "../../../lib/jiraEdit.ts";
import { initialsOf } from "../../../lib/avatarColour.ts";
import { tintOf } from "../../../lib/jiraStepPlan.ts";
import { sprintDates } from "./menus/cardActions.ts";

export interface SprintChoice { id: string; name: string; dates: string; tag: "Current" | "Next" | "" }

/** The active sprint first, then the future ones in the board's order. Empty when the board has none open. */
export function sprintChoices(ctx: Pick<JiraBoardContext, "sprint" | "futures" | "next"> | null): SprintChoice[] {
  if (!ctx) return [];
  const futures = ctx.futures ?? (ctx.next ? [ctx.next] : []);
  const nextId = futures.find((x) => x.start)?.id ?? futures[0]?.id;
  return [
    ...(ctx.sprint ? [{ id: ctx.sprint.id, name: ctx.sprint.name, dates: sprintDates(ctx.sprint), tag: "Current" as const }] : []),
    ...futures.map((s) => ({ id: s.id, name: s.name, dates: sprintDates(s), tag: s.id === nextId ? ("Next" as const) : ("" as const) })),
  ];
}

/** "No open sprints on this board" only when the board was read and holds none; null while it is unread. */
export function sprintEmptyNote(ctx: unknown, choices: readonly SprintChoice[]): string | null {
  return ctx && !choices.length ? "No open sprints on this board" : null;
}

/** The board's columns as status pills, in the board's order, coloured as the card's own Status menu draws them. */
export function statusOptions(columns: readonly string[], statuses: readonly ListStatus[]): SelectOption[] {
  const by = new Map(statuses.map((s) => [s.status, s]));
  return columns.map((name) => {
    const s = by.get(name);
    return { value: name, label: name, pill: true, ...(s?.color ? { tint: s.color } : {}), ...(s && (s.type === "done" || s.type === "closed") ? { dim: true } : {}) };
  });
}

/** Priority ids as the card's menu draws them: the site's own order, the ink running from hot to cold. */
export const priorityChoices = (list: readonly { id: string; name: string }[]): { id: string; label: string; c: string }[] =>
  list.map((p, i, all) => ({ id: p.id, label: p.name, c: priorityInk(i, all.length) }));

/** Jira people as the picker's rows; the row's number is its handle back to the person. */
export const peopleMembers = (people: readonly JiraPerson[]): ListMember[] =>
  people.map((p, i) => ({ id: i, name: p.name, initials: initialsOf(p.name), color: tintOf(p.name), ...(p.avatar ? { avatar: p.avatar } : null), ...(p.email ? { email: p.email } : null), ...(p.me ? { me: true } : null) }));
