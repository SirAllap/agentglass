/*
 * The merge form's card row, when the card is Jira's.
 *
 * ClickUp's row is shaped by a workspace setting (the merge step) and by the
 * list a card sits in. A Jira card has neither: where it can go is the moves
 * its workflow offers from where it stands now, read when the form opens, and
 * there is no setting to switch the row on, because the row starts on "leave
 * it there" and writes nothing until a move is picked.
 *
 * Ceiling: one move, and not one that asks for a field (those are listed and
 * cannot be picked). No assignee change rides on the move; that is the
 * hand-off slice's.
 */
import { api } from "./api.ts";
import { jiraStatusOptions, type StatusOption } from "./trackerStatus.ts";

export interface JiraMergeCard {
  /** The card's key: what the write is addressed to. */
  key: string;
  label: string;
  /** What the card store is keyed by, so the write's answer lands where the chip reads it. */
  query: string;
  title: string;
  status: string;
  statusColor?: string;
  /** The stamp the person saw; the server refuses the move if the card changed since. */
  updated: number;
  /** Whether this app may change cards at all (the Jira write switch). */
  writes: boolean;
  options: StatusOption[];
  /** Why there are no options, when there are none: "You cannot move ORBIT-1042". */
  cannot?: string;
}

export type JiraMergeLookup = { ok: true; card: JiraMergeCard } | { ok: false; why: string };

/** Two reads in parallel and a third only when moving is allowed; none writes. */
export async function lookUpJiraCard(ref: { label: string; query: string }): Promise<JiraMergeLookup> {
  const [found, status] = await Promise.all([
    api.jiraFind(ref.query).catch(() => null),
    api.jiraStatus().catch(() => null),
  ]);
  const task = found?.ok ? found.task : undefined;
  if (!task) return { ok: false, why: found?.error || "Jira could not find it" };
  const writes = status?.writes === true;
  const base = {
    key: task.customId || task.id, label: ref.label, query: ref.query, title: task.title, status: task.status,
    ...(task.statusColor ? { statusColor: task.statusColor } : null), updated: task.updated, writes,
  };
  if (!writes) return { ok: true, card: { ...base, options: [] } };
  const opts = await jiraStatusOptions(task);
  return { ok: true, card: opts.ok ? { ...base, options: opts.data ?? [] } : { ...base, options: [], cannot: opts.error } };
}

/** What the dialog answers with for a pick: nothing, unless a move was picked. */
export function jiraMergeMove(card: JiraMergeCard, pick: string) {
  const opt = card.options.find((o) => o.key === pick);
  if (!opt || opt.needs?.length) return undefined;
  return {
    id: card.key, label: card.label, to: opt.key, toLabel: opt.label, updated: card.updated,
    tracker: "jira" as const, query: card.query,
  };
}
