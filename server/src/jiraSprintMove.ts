/*
 * Move cards into a sprint: Jira Software's `POST /rest/agile/1.0/sprint/{id}/issue`, the same path on Cloud and Data
 * Center. Behind the Jira write switch like every write here. The body names the sprint by its numeric id and the cards by
 * their keys, each checked against the card-key shape before anything is sent. A move is not undone here.
 */
import { ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, jiraCall, jiraWriteEnabled, storedCreds, type JiraCreds } from "./jira.ts";
import { forgetViewReads } from "./jiraboards.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const no = (error: string): WriteOutcome => ({ ok: false, error });
/** Jira takes at most 50 cards in one request. */
export const SPRINT_MOVE_MAX = 50;

export function sprintMoveBody(sprint: unknown, keys: unknown): { ok: true; id: string; body: { issues: string[] } } | { ok: false; error: string } {
  const id = String(sprint ?? "").trim();
  if (!/^\d{1,9}$/.test(id)) return { ok: false, error: "This board has no active sprint to move the card to" };
  const list = Array.isArray(keys) ? keys.map((k) => String(k).trim().toUpperCase()) : [];
  if (!list.length) return { ok: false, error: "Say which card to move" };
  if (list.length > SPRINT_MOVE_MAX) return { ok: false, error: `Move at most ${SPRINT_MOVE_MAX} cards at once` };
  if (!list.every((k) => ISSUE_KEY.test(k))) return { ok: false, error: "That is not a Jira card id" };
  return { ok: true, id, body: { issues: [...new Set(list)] } };
}

export async function moveToSprint(creds: JiraCreds, sprint: unknown, keys: unknown): Promise<WriteOutcome> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  const built = sprintMoveBody(sprint, keys);
  if (!built.ok) return no(built.error);
  const r = await jiraCall<unknown>(creds, `/rest/agile/1.0/sprint/${built.id}/issue`, { method: "POST", body: built.body, fresh: true });
  if (!r.ok) {
    if (r.status === 400) return no("Jira did not accept that sprint: it may be closed, or the card is on another board");
    if (r.status === 403) return no("Your Jira account cannot change that sprint");
    if (r.status === 404) return no("That sprint or card is gone: reload the board");
    return { ok: false, unauthorised: r.unauthorised, error: r.error ?? "Jira did not accept the move" };
  }
  forgetViewReads();
  return { ok: true };
}

/**
 * Take cards out of their sprint: `POST /rest/agile/1.0/backlog/issue`, the same path on both flavors. The body is the same
 * list of card keys, checked the same way; there is no sprint id, because the backlog is the place a card goes when it has none.
 */
export async function moveToBacklog(creds: JiraCreds, keys: unknown): Promise<WriteOutcome> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  const built = sprintMoveBody("0", keys);
  if (!built.ok) return no(built.error);
  const r = await jiraCall<unknown>(creds, "/rest/agile/1.0/backlog/issue", { method: "POST", body: built.body, fresh: true });
  if (!r.ok) {
    if (r.status === 400) return no("Jira did not accept that: the card may be on a board with no backlog");
    if (r.status === 403) return no("Your Jira account cannot change that card's sprint");
    if (r.status === 404) return no("That card is gone: reload the board");
    return { ok: false, unauthorised: r.unauthorised, error: r.error ?? "Jira did not accept the move" };
  }
  forgetViewReads();
  return { ok: true };
}

export const moveToBacklogStored = (keys: unknown): Promise<WriteOutcome> => {
  const c = storedCreds();
  return c ? moveToBacklog(c, keys) : Promise.resolve(no(NOT_CONNECTED));
};

export const moveToSprintStored = (sprint: unknown, keys: unknown): Promise<WriteOutcome> => {
  const c = storedCreds();
  return c ? moveToSprint(c, sprint, keys) : Promise.resolve(no(NOT_CONNECTED));
};
