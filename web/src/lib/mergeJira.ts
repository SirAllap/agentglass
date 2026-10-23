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
import { planOf } from "../../../shared/stepBlocks.ts";
import { NO_ASSIGN } from "./stepAssign.ts";
import { LEAVE_ALONE } from "./cardMove.ts";

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
  /**
   * The merge step, when the site set one up with a move: its status names (the site's own), and whether the
   * status is asked here. A move from a step is run as the step, so what it also does (comment, link, people) rides on it.
   */
  step?: { names: string[]; ask: boolean; /** The step has a move block. */ hasMove: boolean; /** It does more than move (a comment, a link, people). */ extras: boolean };
}

/** The option a step's names point at: the first name any of the card's moves ends in, case aside. */
export function stepOption(card: Pick<JiraMergeCard, "options" | "step">): StatusOption | undefined {
  const names = (card.step?.names ?? []).map((x) => x.trim().toLowerCase());
  for (const name of names) {
    const hit = card.options.find((o) => !o.needs?.length && o.toStatus.trim().toLowerCase() === name);
    if (hit) return hit;
  }
  return undefined;
}

/** Can the merge step make its move on this card from where it stands? A step that asks can pick any move; a fixed one needs its own. */
export const stepReaches = (card: Pick<JiraMergeCard, "options" | "step">): boolean =>
  !card.step?.hasMove || card.step.ask || !!stepOption(card);

/**
 * The moves the merge row offers. A fixed step offers its own move and no other, because the server moves the card
 * where the step says; one that cannot be reached from here offers them all (a pick is then made on its own, and the
 * row says so); a step with no move offers none, because it would not make one.
 */
export function movesOffered(card: Pick<JiraMergeCard, "options" | "step">): StatusOption[] {
  if (!card.step) return card.options;
  if (!card.step.hasMove) return [];
  if (card.step.ask || !stepReaches(card)) return card.options;
  return card.options.filter((o) => o === stepOption(card));
}

export type JiraMergeLookup = { ok: true; card: JiraMergeCard } | { ok: false; why: string };

/** Two reads in parallel and a third only when moving is allowed; none writes. */
export async function lookUpJiraCard(ref: { label: string; query: string }): Promise<JiraMergeLookup> {
  const [found, status, saved] = await Promise.all([
    api.jiraFind(ref.query).catch(() => null),
    api.jiraStatus().catch(() => null),
    api.jiraSteps().catch(() => null),
  ]);
  const merge = saved?.ok ? saved.steps?.merge : undefined;
  const plan = merge?.enabled ? planOf<string | number>("merge", { enabled: true, statusNames: [], assign: NO_ASSIGN, blocks: merge.blocks }) : null;
  const move = plan?.move ?? null;
  const task = found?.ok ? found.task : undefined;
  if (!task) return { ok: false, why: found?.error || "Jira could not find it" };
  const writes = status?.writes === true;
  const base = {
    key: task.customId || task.id, label: ref.label, query: ref.query, title: task.title, status: task.status,
    ...(task.statusColor ? { statusColor: task.statusColor } : null), updated: task.updated, writes,
  };
  const step = plan ? { step: { names: move?.names ?? [], ask: move?.ask === true, hasMove: !!move, extras: merge!.blocks.some((b) => b.type !== "move") } } : null;
  if (!writes) return { ok: true, card: { ...base, ...step, options: [] } };
  const opts = await jiraStatusOptions(task);
  return { ok: true, card: opts.ok ? { ...base, ...step, options: opts.data ?? [] } : { ...base, ...step, options: [], cannot: opts.error } };
}

/**
 * What the dialog answers with for a pick: nothing, unless a move was picked or the merge step has more to do than
 * move. Under a step the write is the step (so what it also does rides on it), by the status's NAME, which is what
 * the server resolves; "Leave it there" tells the step to skip its move and still run the rest.
 */
export function jiraMergeMove(card: JiraMergeCard, pick: string) {
  const base = { id: card.key, label: card.label, updated: card.updated, tracker: "jira" as const, query: card.query };
  if (pick === LEAVE_ALONE) {
    if (!card.step?.extras) return undefined;
    return { ...base, to: "", toLabel: card.status, step: true as const, stay: true as const };
  }
  const opt = card.options.find((o) => o.key === pick);
  if (!opt || opt.needs?.length) return undefined;
  const asStep = !!card.step?.hasMove && stepReaches(card);
  return {
    ...base, to: opt.key, toLabel: opt.label, toStatus: opt.toStatus,
    // The merge step sets what the move does besides moving; a pick it cannot make is made on its own.
    ...(asStep ? { step: true as const } : null),
  };
}
