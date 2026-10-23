/*
 * Who is on a card, and the hand-off, for a tracker with one assignee (Jira).
 *
 * ClickUp's own people picker and hand-off button stay in the pull request
 * panel (`CardPeoplePick`, `CardReadyForQaButton`) with the bodies they have
 * always sent; this is the other shape. A Jira card has one person or nobody,
 * the people to pick from are asked of the site by what was typed (it has no
 * roster to hand over), and the hand-off is ONE request: the server orders the
 * move and the unassign, so no client can race its own `updated` stamp.
 *
 * Nothing here names a status: the hand-off's destination is a setting, by the
 * site's own status id, and its label is that status's own name.
 */
import { api } from "./api.ts";
import type { JiraHandoffRule, JiraPerson, ProviderTask } from "../../../shared/providers.ts";
import type { StatusWriteResult } from "./trackerStatus.ts";

export type PersonOption = JiraPerson;
export interface PeopleResult { ok: boolean; data?: PersonOption[]; error?: string; throttled?: boolean }
/** A write that may have landed only in part: `partial` is said as a warning. */
export type CardWriteResult = StatusWriteResult & { partial?: string };

const UNREACHABLE = "Could not reach the server";
const keyOf = (t: ProviderTask): string => t.customId || t.id;

/** How long typing has to pause before the site is asked. */
export const PEOPLE_WAIT_MS = 300;

export async function jiraPeople(task: ProviderTask, query: string, transition = ""): Promise<PeopleResult> {
  const r = await api.jiraAssignable(keyOf(task), query.trim(), transition).catch(() => null);
  if (!r?.ok) return { ok: false, error: r?.error || UNREACHABLE, ...(r?.throttled ? { throttled: true } : null) };
  return { ok: true, data: r.people ?? [] };
}

/** One person on, or nobody (`set: null`), with the stamp the person saw. */
export async function jiraSetPeople(task: ProviderTask, change: { set: string | null }): Promise<CardWriteResult> {
  return api.jiraSetAssignee(keyOf(task), change.set, task.updated)
    .catch(() => ({ ok: false, error: UNREACHABLE } as CardWriteResult));
}

export async function jiraHandOff(task: ProviderTask, choice: { to?: string; clear?: boolean } = {}): Promise<CardWriteResult> {
  return api.jiraHandOff(keyOf(task), task.updated, choice)
    .catch(() => ({ ok: false, error: UNREACHABLE } as CardWriteResult));
}

/** Is this person the one on the card now? Matched by the card's own id for them, never by name. */
export const isOnCard = (task: ProviderTask, p: PersonOption): boolean =>
  (task.people ?? []).some((x) => !!x.key && x.key === p.id);

/**
 * The hand-off button for a project's rule, or null for none. A fixed
 * destination is the label ("Move to QA"); one that asks when it runs opens a
 * dialog that starts from it.
 */
export function handoffOffer(rule: JiraHandoffRule | undefined): { label: string; asks: boolean } | null {
  if (!rule) return null;
  const asks = rule.askTo || rule.askClear;
  if (rule.askTo) return { label: "Hand off…", asks };
  if (!rule.to) return null;
  return { label: `Move to ${rule.to.name}`, asks };
}

/**
 * What a hand-off answer says, as the one line beside the card: a refusal and
 * a partial landing both start with "!" (drawn as a warning), so a move that
 * left the assignee on is never read as plain success.
 */
export function handoffSaid(r: CardWriteResult): string {
  if (!r.ok) return `!${r.conflict ? "somebody changed this card while you had it open" : r.error || "Jira refused that"}`;
  if (r.partial) return `!${r.partial}`;
  const who = r.task?.people?.[0]?.name;
  return `now ${r.task?.status ?? "moved"}${who ? "" : " · unassigned"}`;
}
