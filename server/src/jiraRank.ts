/*
 * Put a card before or after another on the board: Jira Software's rank, the
 * order a board is read in (`ORDER BY Rank`). One request, `PUT
 * /rest/agile/1.0/issue/rank`, the same path on Cloud and Data Center.
 *
 * Behind the Jira write switch like every write here, and built on keys only:
 * both are checked against the card-key shape before anything is sent, and the
 * body names exactly one card and exactly one neighbour.
 *
 * There is no stamp check, on purpose and unlike the field writes beside it. A
 * stamp (`updated`) guards a value somebody else may have changed under the
 * person's hands; a rank is not a value, it is a position relative to a named
 * neighbour, and Jira re-places the card against that neighbour whatever else
 * moved meanwhile. A read first would cost a request to protect nothing, and a
 * drop is meant to cost one. What a stale screen can do is put the card beside
 * a neighbour that has since moved, which is what the person asked for.
 *
 * After a rank the held board reads are dropped (the minute they were kept for
 * is now wrong about order), and nothing is read back: the screen has already
 * drawn the order it asked for and the next read says what Jira holds.
 *
 * Ceilings, on purpose: one card at a time (the endpoint takes a list; a
 * multi-card drag is the next thing after this and is not here); a drop between
 * two cards is expressed against one of them, the one it sits before, or after
 * the last; Jira refuses a rank across boards with different rank fields and
 * says so in one sentence; a rank is not undone here, the person drags it back.
 */
import { ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, jiraCall, jiraWriteEnabled, storedCreds, type JiraCreds, type JiraResult } from "./jira.ts";
import { forgetViewReads } from "./jiraboards.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const no = (error: string): WriteOutcome => ({ ok: false, error });

export interface RankAsk { before?: unknown; after?: unknown }

/** The body of the request, or the sentence that stops it. Pure, so every guard can be broken on purpose in a test. */
export function rankBody(key: string, ask: RankAsk): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const hasBefore = ask.before !== undefined && ask.before !== null && ask.before !== "";
  const hasAfter = ask.after !== undefined && ask.after !== null && ask.after !== "";
  if (hasBefore === hasAfter) return { ok: false, error: "Say whether the card goes before one card or after one card" };
  const other = String(hasBefore ? ask.before : ask.after).trim();
  if (!ISSUE_KEY.test(other)) return { ok: false, error: "That is not a Jira card id" };
  if (other.toUpperCase() === key.toUpperCase()) return { ok: false, error: "A card cannot be ranked against itself" };
  return { ok: true, body: { issues: [key.toUpperCase()], [hasBefore ? "rankBeforeIssue" : "rankAfterIssue"]: other.toUpperCase() } };
}

/** Jira's refusal of a rank, in our words. */
function refusal(r: JiraResult<unknown>): WriteOutcome {
  if (r.status === 400) return no("Jira did not accept that order: the two cards may not be on one board");
  if (r.status === 403) return no("Your Jira account cannot rank that card");
  if (r.status === 404) return no("That card is gone or not one this site shows you: reload the board");
  return { ok: false, unauthorised: r.unauthorised, error: r.error ?? "Jira did not accept that order" };
}

export async function rankCard(creds: JiraCreds, key: string, ask: RankAsk): Promise<WriteOutcome> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  const built = rankBody(key, ask);
  if (!built.ok) return no(built.error);
  const r = await jiraCall<unknown>(creds, "/rest/agile/1.0/issue/rank", { method: "PUT", body: built.body, fresh: true });
  if (!r.ok) return refusal(r);
  forgetViewReads();
  return { ok: true };
}

export const rankStored = (key: string, ask: RankAsk): Promise<WriteOutcome> => {
  const c = storedCreds();
  return c ? rankCard(c, key, ask) : Promise.resolve(no(NOT_CONNECTED));
};
