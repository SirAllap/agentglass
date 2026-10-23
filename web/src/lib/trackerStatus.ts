/*
 * Moving a card, the same way for either tracker.
 *
 * A status is a different thing in each. ClickUp sets one by its name, from the
 * list the card sits in. Jira has no status to set: the card's workflow offers
 * moves from where it stands, each leading to a status, and only those can be
 * made. What a picker needs from both is the same few things, so this is the
 * shape (`StatusOption`) and the two ways of filling it; nothing here names a
 * status or a move, they all come from the tracker.
 *
 * ClickUp's write is the call the status picker has always made, with the same
 * body: `api.clickupCard(id, { status }, updated)`.
 *
 * Ceiling: one move per click, and no path through several moves to a distant
 * status. A Jira move that asks for a field carries `needs` and `fields`: the
 * picker opens a form for them and the write is refused, with nothing sent,
 * until they are given.
 */
import { api } from "./api.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import type { JiraMoveField } from "../../../shared/jiraMoveFields.ts";

export interface StatusOption {
  /** ClickUp: the status name. Jira: the move's id. */
  key: string;
  label: string;
  /** The status the card ends up in. */
  toStatus: string;
  /** Jira: that status's own id, for the hand-off's choice. */
  toId?: string;
  toKind: "open" | "done" | "other";
  color?: string;
  /** Screen fields the move cannot be made without: set means the move asks first. */
  needs?: string[];
  /** The move's screen, as a form draws it. */
  fields?: JiraMoveField[];
}

export interface StatusOptionsResult { ok: boolean; data?: StatusOption[]; error?: string; throttled?: boolean }
export interface StatusWriteResult { ok: boolean; error?: string; conflict?: boolean; unauthorised?: boolean; task?: ProviderTask }

const UNREACHABLE = "Could not reach the server";

/** ClickUp's list statuses, which are the targets. */
export async function clickupStatusOptions(task: ProviderTask): Promise<StatusOptionsResult> {
  if (!task.listId) return { ok: true, data: [] };
  const r = await api.clickupList(task.listId).catch(() => null);
  if (!r?.ok) return { ok: false, error: r?.error || UNREACHABLE };
  return {
    ok: true,
    data: (r.statuses ?? []).map((s) => ({
      key: s.status,
      label: s.status,
      toStatus: s.status,
      toKind: s.type === "done" || s.type === "closed" ? "done" : "open",
      color: s.color,
    })),
  };
}

export async function clickupSetStatus(task: ProviderTask, opt: StatusOption): Promise<StatusWriteResult> {
  return api.clickupCard(task.id, { status: opt.key }, task.updated)
    .catch(() => ({ ok: false, error: UNREACHABLE, task: undefined } as StatusWriteResult));
}

/**
 * The moves valid from the card's status now. A move into the status the card
 * is already in (a loop in the workflow) is not a move. An empty list is the
 * answer for a missing permission as much as for a finished workflow, so it is
 * an error with the server's sentence: "You cannot move ORBIT-1042".
 */
export async function jiraStatusOptions(task: ProviderTask): Promise<StatusOptionsResult> {
  const r = await api.jiraTransitions(task.customId || task.id).catch(() => null);
  if (!r?.ok) return { ok: false, error: r?.error || UNREACHABLE, ...(r?.throttled ? { throttled: true } : null) };
  const moves = (r.options ?? []).filter((m) => m.toStatus !== task.status);
  if (!moves.length) return { ok: false, error: r.cannot || `You cannot move ${task.customId || task.id}` };
  return {
    ok: true,
    data: moves.map((m) => ({
      key: m.id,
      label: m.label,
      toStatus: m.toStatus,
      ...(m.toId ? { toId: m.toId } : null),
      toKind: m.toKind,
      ...(m.color ? { color: m.color } : null),
      ...(m.needs?.length ? { needs: m.needs } : null),
      ...(m.fields?.length ? { fields: m.fields } : null),
    })),
  };
}

export async function jiraSetStatus(task: ProviderTask, opt: StatusOption, fields?: Record<string, string | string[]>): Promise<StatusWriteResult> {
  // A move that asks, asked with nothing: said here and not sent (the form is how it is given).
  if (opt.needs?.length && !fields) return { ok: false, error: `That move needs ${opt.needs.join(", ")}` };
  return api.jiraTransition(task.customId || task.id, opt.key, task.updated, fields)
    .catch(() => ({ ok: false, error: UNREACHABLE, task: undefined } as StatusWriteResult));
}
