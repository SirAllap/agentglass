/*
 * Time logged on a Jira card, written from the pane or the door: an entry added,
 * and the connected account's own entries changed or deleted.
 *
 * Every write is behind the Jira write switch and the card's stamp, like the
 * card's other changes: a stamp that is not a number is refused with no request,
 * and one the card has moved past is a conflict that sends nothing. A time is
 * checked by shared/jiraWorklog.ts before any request, so a typo costs none.
 *
 * Time tracking is the site's, per card. Where the card's own read has no
 * `timetracking` field there is nothing to log against, and that is said
 * instead of sent.
 *
 * Whose entry it is, is read from the site after the person has asked, not
 * trusted from what the pane drew: an entry is changed or deleted only when its
 * author is the connected account. Jira would let an administrator through, and
 * this is not the place to find out.
 *
 * The remaining estimate is changed by one of four modes (shared/jiraWorklog.ts).
 * The answer carries the estimate as it was read before the write and as it is
 * read after, so the sentence that says what happened is the site's and not a sum
 * of ours. An added entry can be put back (its id is in the answer, and a delete
 * that sets the estimate to what it was); a deleted entry cannot.
 *
 * Requests, counted: adding is the card's stamp and estimate, the POST and the
 * card read back (3). Changing or deleting is those plus one read of the entry
 * (4), the stamp and the entry asked together. A failed write sends no read-back.
 *
 * Ceilings, on purpose: the note on an entry is Markdown with nobody to notify
 * (a mention is not offered here) and cannot be taken off an entry once it is
 * there; an entry of an author whose account the site hides is not changeable;
 * no entry is visible to a group only (the site's own default applies).
 */
import {
  ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, epoch, jiraCall, jiraWriteEnabled, stale, storedCreds, taskContext, unreadable,
  type JiraCreds, type JiraResult,
} from "./jira.ts";
import { readDetail } from "./jiraComments.ts";
import { personId } from "./jiraCardRead.ts";
import { markdownToAdf, markdownToWiki } from "./jiraAdf.ts";
import { adjustOf, adjustQuery, parseDuration, startedStamp, workSaid, type WorklogOp } from "../../shared/jiraWorklog.ts";
import type { TaskDetail } from "../../shared/providers.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ENTRY_ID = /^\d{1,12}$/;
const MAX_NOTE = 30_000;

export type WorklogOutcome = WriteOutcome & {
  detail?: TaskDetail; more?: number;
  /** The id of the entry that was added or changed. */
  entry?: string;
  /** The remaining estimate as the site gave it before the write and after it, empty when none is set. */
  before?: string; after?: string;
  /** The sentence that says what happened, ours and the site's numbers. */
  said?: string;
  removed?: boolean;
};

export interface WorklogAsk {
  /** `1h 30m`. Required to add, optional to change. */
  time?: unknown;
  /** A day, `2026-01-31`: when the work was done. */
  started?: unknown;
  /** Markdown. */
  note?: unknown;
  /** `{ mode, value }`, see shared/jiraWorklog.ts. */
  adjust?: unknown;
}

const no = (error: string): WorklogOutcome => ({ ok: false, error });
const NOT_ACCEPTED = "Jira did not accept that time";

/** What the stamp read says, and the sentence when it says no. */
interface Seen { before: string }

/** The card's stamp and estimate: the write goes ahead only when the card is as the person saw it and has time tracking on. */
async function checkCard(creds: JiraCreds, upper: string, updated: number): Promise<Seen | { stop: WorklogOutcome }> {
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}?fields=updated,timetracking`, { fresh: true });
  if (!r.ok) return { stop: { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not check the card first. ${r.error ?? "Jira did not answer"}` } };
  const f = isObj(r.data) && isObj(r.data.fields) ? r.data.fields : {};
  const now = epoch(f.updated);
  if (!now) return { stop: unreadable() };
  if (now !== updated) return { stop: stale() };
  if (!isObj(f.timetracking)) return { stop: no(`Time tracking is off for ${upper}, so there is no time to log on it`) };
  return { before: str(f.timetracking.remainingEstimate) };
}

/** The entry, when it is the connected account's own; otherwise the sentence that stops the write. */
async function ownEntry(creds: JiraCreds, upper: string, id: string): Promise<{ time: string; me: string } | { stop: WorklogOutcome }> {
  const [r, cx] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/worklog/${id}`, { fresh: true }),
    taskContext(creds),
  ]);
  if (!r.ok || !isObj(r.data)) {
    if (r.status === 404) return { stop: no("That entry is gone: reload the card") };
    return { stop: { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not check the entry first. ${r.error ?? "Jira did not answer"}` } };
  }
  const author = isObj(r.data.author) ? personId(r.data.author) : "";
  if (!cx.me || !author) return { stop: no("Nothing was changed: could not tell whose entry this is") };
  if (author !== cx.me) return { stop: no("That entry is somebody else's: only your own can be changed here") };
  return { time: str(r.data.timeSpent), me: cx.me };
}

/** Why the site refused a work-log write, in our words: its own text never reaches the answer. */
function refusal(r: JiraResult<unknown>, op: WorklogOp, upper: string): WorklogOutcome {
  if (r.status === 400) return no(NOT_ACCEPTED);
  if (r.status === 403) return no(`Your Jira account cannot ${op === "add" ? "log time on" : op === "edit" ? "change time on" : "delete time on"} ${upper}`);
  if (r.status === 404) return no("That entry is gone: reload the card");
  return { ok: false, unauthorised: r.unauthorised, error: r.error ?? NOT_ACCEPTED };
}

/** The pieces every write begins with, checked before any request. */
function gate(key: string, updated: number): WorklogOutcome | null {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  if (!ISSUE_KEY.test(key)) return no("That is not a Jira card id");
  // A write with nothing to compare against would go out unchecked.
  if (!Number.isFinite(updated) || updated <= 0) return no("Nothing was changed: reload the card and try again");
  return null;
}

/** The note as the site's own format; null when it is too long to send. */
function noteBody(note: string, v: 2 | 3): { comment: unknown } | null {
  if (note.length > MAX_NOTE) return null;
  return { comment: v === 3 ? markdownToAdf(note, []) : markdownToWiki(note, []) };
}

/** The card as it now stands, with the estimate before and after, in the answer. */
async function finish(creds: JiraCreds, upper: string, op: WorklogOp, time: string, seen: Seen, extra: Partial<WorklogOutcome>): Promise<WorklogOutcome> {
  const back = await readDetail(creds, upper, { fresh: true, threads: false });
  const said = (after: string) => workSaid(op, time, seen.before, after);
  if (!back.ok || !back.data) return { ok: true, partial: `${op === "add" ? "The time was logged" : op === "edit" ? "The entry was changed" : "The entry was deleted"}, but the card could not be read back. Reload it.`, before: seen.before, ...extra };
  const after = back.data.detail.tracking?.remaining ?? "";
  return { ok: true, task: back.data.detail.task, detail: back.data.detail, more: back.data.more, before: seen.before, after, said: said(after), ...extra };
}

/** Log time on a card. No retry: a second POST is a second entry. */
export async function logWork(creds: JiraCreds, key: string, ask: WorklogAsk, updated: number, now: Date = new Date()): Promise<WorklogOutcome> {
  const stop = gate(key, updated);
  if (stop) return stop;
  const time = parseDuration(ask.time);
  if (!time.ok) return no(time.error);
  const started = startedStamp(ask.started, now);
  if (!started.ok) return no(started.error);
  const adjust = adjustOf(ask.adjust, "add");
  if (!adjust.ok) return no(adjust.error);
  const v = apiOf(creds);
  const text = typeof ask.note === "string" ? ask.note.trim() : "";
  const note = text ? noteBody(text, v) : {};
  if (!note) return no("That note is too long for Jira");
  const upper = key.toUpperCase();
  const seen = await checkCard(creds, upper, updated);
  if ("stop" in seen) return seen.stop;
  const post = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/worklog?${adjustQuery("add", adjust.adjust)}`, {
    method: "POST", body: { timeSpent: time.text, ...(started.started ? { started: started.started } : {}), ...note },
  });
  if (!post.ok) {
    // No answer, or a server error, says nothing about whether it landed, and sending it again would be a second entry.
    if (!post.throttled && !post.unauthorised && post.status !== 400 && post.status !== 403 && (post.status === undefined || post.status >= 500)) {
      return no(`${post.error ?? "Jira did not answer"}. The time may have been logged: reload the card before sending it again`);
    }
    return refusal(post, "add", upper);
  }
  const id = isObj(post.data) ? (typeof post.data.id === "number" ? String(post.data.id) : str(post.data.id)) : "";
  return finish(creds, upper, "add", time.text, seen, id ? { entry: id } : {});
}

/** Change your own entry: its time, the day, the note, and how the remaining estimate follows. */
export async function editWork(creds: JiraCreds, key: string, id: string, ask: WorklogAsk, updated: number, now: Date = new Date()): Promise<WorklogOutcome> {
  const stop = gate(key, updated);
  if (stop) return stop;
  if (typeof id !== "string" || !ENTRY_ID.test(id)) return no("That is not an entry this card has");
  const time = ask.time === undefined ? null : parseDuration(ask.time);
  if (time && !time.ok) return no(time.error);
  const started = startedStamp(ask.started, now);
  if (!started.ok) return no(started.error);
  const adjust = adjustOf(ask.adjust, "edit");
  if (!adjust.ok) return no(adjust.error);
  const v = apiOf(creds);
  const text = typeof ask.note === "string" ? ask.note.trim() : "";
  const note = text ? noteBody(text, v) : {};
  if (!note) return no("That note is too long for Jira");
  if (!time && !started.started && !text) return no("Nothing to change: give a time, a day or a note");
  const upper = key.toUpperCase();
  const [seen, own] = await Promise.all([checkCard(creds, upper, updated), ownEntry(creds, upper, id)]);
  if ("stop" in seen) return seen.stop;
  if ("stop" in own) return own.stop;
  const body = { ...(time?.ok ? { timeSpent: time.text } : {}), ...(started.started ? { started: started.started } : {}), ...note };
  const put = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/worklog/${id}?${adjustQuery("edit", adjust.adjust)}`, { method: "PUT", body });
  if (!put.ok) return refusal(put, "edit", upper);
  return finish(creds, upper, "edit", time?.ok ? time.text : own.time, seen, { entry: id });
}

/** Delete your own entry, for good. How the remaining estimate follows is the caller's say. */
export async function deleteWork(creds: JiraCreds, key: string, id: string, ask: Pick<WorklogAsk, "adjust">, updated: number): Promise<WorklogOutcome> {
  const stop = gate(key, updated);
  if (stop) return stop;
  if (typeof id !== "string" || !ENTRY_ID.test(id)) return no("That is not an entry this card has");
  const adjust = adjustOf(ask.adjust, "delete");
  if (!adjust.ok) return no(adjust.error);
  const upper = key.toUpperCase();
  const [seen, own] = await Promise.all([checkCard(creds, upper, updated), ownEntry(creds, upper, id)]);
  if ("stop" in seen) return seen.stop;
  if ("stop" in own) return own.stop;
  const del = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/worklog/${id}?${adjustQuery("delete", adjust.adjust)}`, { method: "DELETE" });
  if (!del.ok) return refusal(del, "delete", upper);
  return finish(creds, upper, "delete", own.time || "time", seen, { removed: true });
}

// What the routes call: the stored connection, or the sentence that says there is none.
const stored = async (run: (c: JiraCreds) => Promise<WorklogOutcome>): Promise<WorklogOutcome> => {
  const c = storedCreds();
  return c ? run(c) : no(NOT_CONNECTED);
};
export const logWorkStored = (key: string, ask: WorklogAsk, updated: number): Promise<WorklogOutcome> => stored((c) => logWork(c, key, ask, updated));
export const editWorkStored = (key: string, id: string, ask: WorklogAsk, updated: number): Promise<WorklogOutcome> => stored((c) => editWork(c, key, id, ask, updated));
export const deleteWorkStored = (key: string, id: string, ask: Pick<WorklogAsk, "adjust">, updated: number): Promise<WorklogOutcome> => stored((c) => deleteWork(c, key, id, ask, updated));
