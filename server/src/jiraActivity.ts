/*
 * What happened on a Jira card, read for the pane's Activity: the change
 * history, the work log, and the comments the card read did not carry.
 *
 * Requests, counted. Opening a card asks for none of this except the first 20
 * work-log entries, which ride on the issue read as a field. The history is one
 * request when its tab (or All) is opened and one more per 100 entries after
 * that; comments past the read are one request per 50; work log past the first
 * 20 is one request for the rest. Nothing here is polled.
 *
 * The history is heavy (the author repeats on every entry) and permanent, so it
 * is never asked for on a board read and never with the issue.
 *
 * Cloud pages its history (`GET issue/{k}/changelog`). Data Center 9 has no
 * such endpoint, so the history is read inside the issue (`expand=changelog`),
 * which answers its first 100 entries and is one request whatever page is
 * asked: said by `more: true` with nothing after it.
 *
 * Ceiling: the sentence for a field the table below does not know is "updated
 * <the field's name>", never its raw values, because a value of an unknown
 * field is whatever a plugin put there. Estimates are shown in hours and
 * minutes, since the days in a site's working week are its own setting.
 */
import { apiOf, jiraCall, withStored, type JiraCreds, type JiraResult } from "./jira.ts";
import { redacted } from "./credentials.ts";
import { avatarOf, commentRows, epochOf, textReader } from "./jiraCardRead.ts";
import type { CardEvent, TaskDetail } from "../../shared/providers.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** History entries per request, Jira's own ceiling for the changelog. */
export const HISTORY_PAGE = 100;
/** Comments per request. */
export const COMMENT_PAGE = 50;
/** Work-log entries the issue read carries, and the most one request here brings. */
export const WORKLOG_IN_READ = 20;
const WORKLOG_PAGE = 100;
const SENTENCE_MAX = 240;

const clip = (s: string, n = SENTENCE_MAX): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Seconds as a person reads time: "45m", "1h 30m". Hours and minutes only (see the file's note). */
export function humanSeconds(raw: string): string {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isFinite(n)) return raw;
  if (n === 0) return "0m";
  const h = Math.floor(n / 3600), m = Math.round((n % 3600) / 60);
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** The fields whose values are seconds written as text, and what a person calls them. */
const TIME_FIELDS: Record<string, string> = { timeestimate: "Remaining estimate", timeoriginalestimate: "Original estimate", timespent: "Time spent" };
/** Fields the history records for the site's own bookkeeping: a row would say nothing a person asked about. */
// A comment and a work-log entry have their own tabs, so the history's note that one was written, edited or deleted says nothing new.
const QUIET_FIELDS = new Set(["worklogid", "worklogtimespent", "comment", "rank", "sprint", "workratio", "lastviewed"]);

/** Fields whose values are plain words a person chose, said "from A to B" under the name a person gives them. */
const PLAIN_FIELDS: Record<string, string> = {
  status: "Status", priority: "Priority", issuetype: "Type", "fix version": "Fix version", "affects version": "Affects version",
  component: "Component", reporter: "Reporter", environment: "Environment",
};

interface Item { field: string; from: string; to: string; fromString: string; toString: string }
const itemOf = (raw: unknown): Item | null => {
  if (!isObj(raw) || !str(raw.field)) return null;
  const s = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return { field: str(raw.field), from: s(raw.from), to: s(raw.to), fromString: s(raw.fromString), toString: s(raw.toString) };
};

const quoted = (s: string): string => `"${clip(s, 80)}"`;

/**
 * One changed field as a sentence after the person's name: "changed the Status
 * from "To Do" to "In Progress"". Null when the site recorded it for its own
 * reasons. The table is the one place that knows a field's name from its id.
 */
export function describeItem(it: Item): string | null {
  const key = it.field.toLowerCase();
  if (QUIET_FIELDS.has(key)) return null;
  const was = it.fromString, now = it.toString;
  if (key in TIME_FIELDS) {
    const label = TIME_FIELDS[key]!;
    const a = humanSeconds(was || it.from), b = humanSeconds(now || it.to);
    if (a && b) return `changed the ${label} from ${a} to ${b}`;
    return b ? `set the ${label} to ${b}` : `cleared the ${label}`;
  }
  switch (key) {
    case "assignee":
      if (now && was) return `reassigned this from ${was} to ${now}`;
      return now ? `assigned this to ${now}` : "took the assignee off";
    case "labels": {
      // Both ends are the whole list, space separated: what is new and what is gone is the sentence.
      const a = new Set(was.split(/\s+/).filter(Boolean)), b = new Set(now.split(/\s+/).filter(Boolean));
      const added = [...b].filter((x) => !a.has(x)), gone = [...a].filter((x) => !b.has(x));
      return [added.length ? `added ${added.length === 1 ? "the label" : "the labels"} ${added.join(", ")}` : "", gone.length ? `removed ${gone.length === 1 ? "the label" : "the labels"} ${gone.join(", ")}` : ""].filter(Boolean).join(" and ") || null;
    }
    case "duedate":
    case "start date": {
      const label = key === "duedate" ? "Due date" : "Start date";
      const day = (s: string) => /^\d{4}-\d{2}-\d{2}/.exec(s)?.[0] ?? "";
      const a = day(was || it.from), b = day(now || it.to);
      if (a && b) return `changed the ${label} from ${a} to ${b}`;
      // A site records a clear of a field nobody had filled: nothing happened.
      if (!a && !b) return null;
      return b ? `set the ${label} to ${b}` : `cleared the ${label}`;
    }
    case "flagged":
      return now ? "flagged this" : "removed the flag";
    case "link":
      return now ? `linked this: ${clip(now)}` : `removed a link: ${clip(was)}`;
    case "remoteworkitemlink":
    case "remoteissuelink":
    case "weblink":
      return now ? `added a web link: ${clip(now)}` : `removed a web link: ${clip(was)}`;
    case "attachment":
      return now ? `attached ${clip(now)}` : `removed the attachment ${clip(was)}`;
    case "issueparentassociation":
    case "parent":
      return now ? `set the parent to ${clip(now)}` : "took the parent off";
    case "description":
      return "updated the description";
    case "summary":
      return now ? `renamed this to ${quoted(now)}` : "changed the summary";
    case "resolution":
      return now ? `set the Resolution to ${now}` : "cleared the Resolution";
    default: {
      const label = PLAIN_FIELDS[key];
      // A field with no entry is named and nothing more: its values are whatever a plugin put there.
      if (!label) return `updated ${clip(it.field, 60)}`;
      if (was && now) return `changed the ${label} from ${quoted(was)} to ${quoted(now)}`;
      return now ? `set the ${label} to ${quoted(now)}` : `cleared the ${label} (was ${quoted(was)})`;
    }
  }
}

/** The history entries of one answer as events, in the order Jira gave them within each entry, oldest first. */
export function historyEvents(histories: unknown): CardEvent[] {
  const out: { e: CardEvent; n: number }[] = [];
  let n = 0;
  for (const h of Array.isArray(histories) ? histories : []) {
    if (!isObj(h)) continue;
    const a = isObj(h.author) ? h.author : {};
    const who = str(a.displayName) || str(a.name) || "Someone";
    const avatar = avatarOf(a);
    const at = epochOf(h.created);
    for (const raw of Array.isArray(h.items) ? h.items : []) {
      const it = itemOf(raw);
      const text = it ? describeItem(it) : null;
      if (!text) continue;
      out.push({ e: { at, kind: "change", who, text, ...(avatar ? { avatar } : {}) }, n: n++ });
    }
  }
  // Same second keeps the site's own order (an entry's items are one edit).
  return out.sort((x, y) => x.e.at - y.e.at || x.n - y.n).map((x) => x.e);
}

/** The work log of one answer as events: who logged how much, and the note they left. */
export function worklogEvents(raw: unknown, v: 2 | 3): CardEvent[] {
  const read = textReader(v, {});
  const out: CardEvent[] = [];
  for (const w of Array.isArray(raw) ? raw : []) {
    if (!isObj(w)) continue;
    const a = isObj(w.author) ? w.author : {};
    const who = str(a.displayName) || str(a.name) || "Someone";
    const avatar = avatarOf(a);
    const spent = str(w.timeSpent) || (typeof w.timeSpentSeconds === "number" ? humanSeconds(String(w.timeSpentSeconds)) : "");
    const note = w.comment == null ? "" : read(w.comment).trim().split("\n")[0] ?? "";
    // `started` is when the work was done; `created` is when it was written down. The first is what the log is read by.
    const at = epochOf(w.started) || epochOf(w.created);
    out.push({ at, kind: "worklog", who, text: `logged ${spent || "time"}${note ? `: ${clip(note, 120)}` : ""}`, ...(avatar ? { avatar } : {}) });
  }
  return out.sort((x, y) => x.at - y.at);
}

export interface ActivityPage {
  events?: CardEvent[];
  comments?: TaskDetail["comments"];
  /** Where the next request for this kind starts; absent when this was the last page. */
  next?: number;
  total: number;
}

const BAD_KEY = "That is not a Jira card id";

/** One page of the change history: Cloud's own page, or Data Center's inside the issue. */
export async function historyPage(creds: JiraCreds, key: string, startAt = 0): Promise<JiraResult<ActivityPage>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: BAD_KEY };
  const v = apiOf(creds);
  const at = Math.max(0, Math.floor(startAt) || 0);
  if (v === 3) {
    const r = await jiraCall<unknown>(creds, `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${at}&maxResults=${HISTORY_PAGE}`, { fresh: true });
    if (!r.ok) return { ...r, data: undefined };
    const box = isObj(r.data) ? r.data : {};
    const total = typeof box.total === "number" ? box.total : 0;
    const last = box.isLast === true || at + HISTORY_PAGE >= total;
    return { ok: true, data: { events: historyEvents(box.values), total, ...(last ? {} : { next: at + HISTORY_PAGE }) } };
  }
  // Only the first page exists here, and it is the whole answer of one request.
  if (at > 0) return { ok: true, data: { events: [], total: 0 } };
  const r = await jiraCall<unknown>(creds, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary&expand=changelog`, { fresh: true });
  if (!r.ok) return { ...r, data: undefined };
  const box = isObj(r.data) && isObj(r.data.changelog) ? r.data.changelog : {};
  return { ok: true, data: { events: historyEvents(box.histories), total: typeof box.total === "number" ? box.total : 0 } };
}

/** The rest of the work log, past the entries the issue read carried. */
export async function worklogPage(creds: JiraCreds, key: string, startAt = WORKLOG_IN_READ): Promise<JiraResult<ActivityPage>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: BAD_KEY };
  const v = apiOf(creds);
  const at = Math.max(0, Math.floor(startAt) || 0);
  const r = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}/worklog?startAt=${at}&maxResults=${WORKLOG_PAGE}`, { fresh: true });
  if (!r.ok) return { ...r, data: undefined };
  const box = isObj(r.data) ? r.data : {};
  const total = typeof box.total === "number" ? box.total : 0;
  const got = Array.isArray(box.worklogs) ? box.worklogs.length : 0;
  return { ok: true, data: { events: worklogEvents(box.worklogs, v), total, ...(at + got < total && got > 0 ? { next: at + got } : {}) } };
}

/** The comments from `startAt` on, oldest first, `COMMENT_PAGE` at a time. */
export async function commentsPage(creds: JiraCreds, key: string, startAt: number, me?: string): Promise<JiraResult<ActivityPage>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: BAD_KEY };
  const v = apiOf(creds);
  const at = Math.max(0, Math.floor(startAt) || 0);
  const r = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}/comment?orderBy=created&startAt=${at}&maxResults=${COMMENT_PAGE}`, { fresh: true });
  if (!r.ok) return { ...r, data: undefined };
  const box = isObj(r.data) ? r.data : {};
  const raw = (Array.isArray(box.comments) ? box.comments : []).filter(isObj);
  const total = typeof box.total === "number" ? box.total : raw.length;
  return { ok: true, data: { comments: commentRows(raw, v, me).comments, total, ...(at + raw.length < total && raw.length > 0 ? { next: at + raw.length } : {}) } };
}

export type ActivityKind = "history" | "worklog" | "comments";
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["history", "worklog", "comments"];

/** What the route calls: the stored connection, or the sentence that says there is none. */
export function activityStored(kind: ActivityKind, key: string, startAt: number): Promise<JiraResult<ActivityPage>> {
  return withStored((c) => {
    if (kind === "history") return historyPage(c, key, startAt);
    if (kind === "worklog") return worklogPage(c, key, startAt);
    return commentsPage(c, key, startAt, redacted("jira")?.accountId);
  });
}
