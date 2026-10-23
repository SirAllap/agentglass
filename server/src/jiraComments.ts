/*
 * A Jira card's words: its description and comments to read, a comment to
 * write, and the people a comment may mention.
 *
 * Which text format goes on the wire is the connection's API generation (see
 * jiraAdf.ts): ADF on Cloud's v3, wiki markup on Data Center's v2. Nothing
 * here looks at the site's address to decide.
 *
 * Requests, counted: reading the card with its words is one GET (the comments
 * come inside the issue, asked for by field name) plus the priority list when
 * it is not remembered. A comment is one POST and one GET of the card again,
 * because a comment moves the card's `updated` and the next move is checked
 * against it. Who can be mentioned is one search per typed query, kept ten
 * minutes.
 *
 * Your own comment can be changed or deleted (two requests each: the comment,
 * to be sure it is yours, then the write) and answered in a thread (a POST
 * with `parentId`, Cloud only). Reactions are not in Jira's public REST.
 *
 * Ceiling: a card with more comments than the issue read carries says how many
 * were left out and pages for them on request; a reply is one level deep, as
 * Jira's own are.
 */
import { CARD_FIELDS, ISSUE_KEY, apiOf, idText, cardPointsField, jiraCall, jiraWriteEnabled, memoOk, priorities, siteFields, taskContext, toTask, withStored, type JiraCreds, type JiraResult, type TaskContext } from "./jira.ts";
import { ACCOUNT_ID, LOGIN, adfToMarkdown, markdownToAdf, markdownToWiki, readMentions, wikiToMarkdown, type Mention } from "./jiraAdf.ts";
export { readMentions };
import { worklogEvents } from "./jiraActivity.ts";
import { editOf, rememberOffered } from "./jiraEdit.ts";
import { fileRows, rememberFiles } from "./jiraFiles.ts";
import { attachmentsOf, commentRows, factsOf, fullReader, linkedOf, offeredFields, personId, textReader } from "./jiraCardRead.ts";
import type { TaskDetail, ProviderTask } from "../../shared/providers.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const epoch = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };
const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";

/** Jira's own limit is 32,767 characters; Markdown grows a little on the way. */
const MAX_COMMENT = 30_000;
const PEOPLE_PAGE = 20;

/** Who a person is to Jira: Cloud names them by account id, Data Center by key, then login. */
/** What a mention carries: the account id on Cloud, the login on Data Center. */
const handleOf = (u: Record<string, unknown>, v: 2 | 3): string => (v === 3 ? str(u.accountId) : str(u.name));
const avatarOf = (u: Record<string, unknown>): string | undefined => {
  const a = isObj(u.avatarUrls) ? str(u.avatarUrls["48x48"]) : "";
  return a.startsWith("https://") ? a : undefined;
};

/** The card's description and comments, as Markdown, from one issue read. */
export function toDetail(issue: unknown, task: ProviderTask, v: 2 | 3, me?: string, cx?: TaskContext, ids?: { start?: string; flag?: string; team?: string }): { detail: TaskDetail; more: number } {
  const f = isObj(issue) && isObj(issue.fields) ? issue.fields : {};
  const box = isObj(f.comment) ? f.comment : {};
  const raw = (Array.isArray(box.comments) ? box.comments : []).filter(isObj);
  const { comments, names } = commentRows(raw, v, me, [f.assignee]);
  const total = typeof box.total === "number" ? box.total : comments.length;
  // A subtask arrives as a stub (key, summary, status): enough for a row, not for a project.
  const subtasks = cx ? (Array.isArray(f.subtasks) ? f.subtasks : []).flatMap((s) => { const t = toTask(s, cx); return t ? [t] : []; }) : [];
  // The rest of the card, only when the read asked for it: a link list that was not asked for is not "no links".
  const attachments = Array.isArray(f.attachment) ? fileRows(attachmentsOf(f), isObj(issue) ? str(issue.key) : "", f, me ?? "") : undefined;
  const linked = cx && Array.isArray(f.issuelinks) ? linkedOf(f, (s) => toTask(s, cx)) : undefined;
  const facts = cx ? factsOf(f, ids ?? {}, offeredFields(issue)) : undefined;
  // The first entries of the work log ride on the read (a field, no request); the rest are a page on demand.
  const wl = isObj(f.worklog) ? f.worklog : null;
  const events = wl ? worklogEvents(wl.worklogs, v, me) : undefined;
  const worklogMore = wl && events && typeof wl.total === "number" ? Math.max(0, wl.total - (Array.isArray(wl.worklogs) ? wl.worklogs.length : 0)) : 0;
  // Time tracking is the site's, per card: where it is off the field is not in the answer at all, and there is nothing to log time against.
  const tt = isObj(f.timetracking) ? f.timetracking : null;
  const tracking = tt ? { remaining: str(tt.remainingEstimate), original: str(tt.originalEstimate), spent: str(tt.timeSpent) } : undefined;
  // The account's own marks on the card ride on the same read. `votes` is absent where the site has voting off.
  const wt = isObj(f.watches) ? f.watches : null, vt = isObj(f.votes) ? f.votes : null;
  const follow = wt || vt ? {
    watching: wt?.isWatching === true, watchers: typeof wt?.watchCount === "number" ? wt.watchCount : null,
    voted: vt?.hasVoted === true, votes: vt && typeof vt.votes === "number" ? vt.votes : null,
  } : undefined;
  return {
    // Asked and empty is an answer ("none left"); not asked, the board's own count stands.
    detail: {
      task: Array.isArray(f.subtasks) ? { ...task, subtasks: f.subtasks.length } : task,
      description: f.description == null ? "" : textReader(v, names)(f.description), subtasks, checklists: [], comments,
      ...(attachments ? { attachments } : {}), ...(linked ? { linked } : {}), ...(facts ? { facts } : {}),
      ...(events ? { events } : {}), ...(worklogMore ? { worklogMore } : {}),
      ...(tracking ? { tracking } : {}), ...(follow ? { follow } : {}),
    },
    more: Math.max(0, total - comments.length),
  };
}

export interface JiraDetail { detail: TaskDetail; more: number }

/** One card with its words. One request, plus the priority list when it is not remembered. */
export async function readDetail(creds: JiraCreds, key: string, o: { fresh?: boolean; /** Ask which comment answers which; the read-back after a comment skips it. */ threads?: boolean } = {}): Promise<JiraResult<JiraDetail>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const v = apiOf(creds);
  // The site's own sprint and points fields, learned once and remembered. Where they cannot be read the card comes without them.
  const found = await siteFields(creds);
  const ids = found.ok && found.data ? found.data : null;
  const ask = { sprint: ids?.sprint, points: cardPointsField(ids) };
  const more = [ids?.start, ids?.flag, ids?.team].filter((x): x is string => !!x);
  const fields = [
    ...CARD_FIELDS, "description", "comment", "parent", "subtasks", "issuelinks", "attachment", "reporter", "issuetype",
    "components", "fixVersions", "versions", "timetracking", "worklog", "watches", "votes",
    ...(ask.sprint ? [ask.sprint] : []), ...(ask.points ? [ask.points] : []), ...more,
  ].join(",");
  // `editmeta` says which Details this card's edit screen offers; it rides on the same read.
  const [r, base] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=${fields}&expand=editmeta`, { fresh: o.fresh }),
    taskContext(creds),
  ]);
  if (!r.ok) return { ...r, data: undefined };
  const cx = { ...base, fields: ask };
  const task = toTask(r.data, cx);
  if (!task) return { ok: false, error: "Jira answered with something that is not a card" };
  const read = toDetail(r.data, task, v, cx.me, cx, ids ?? undefined);
  if (v === 3 && o.threads !== false && read.detail.comments.length) await threadParents(creds, key, read.detail.comments);
  // What this card lets a person change is only said while writing to Jira is on: with it off there is no control to draw.
  const offered = offeredFields(r.data);
  rememberOffered(key, offered);
  rememberFiles(creds, key, isObj(r.data) && isObj(r.data.fields) ? r.data.fields : {}, cx.me ?? "");
  if (jiraWriteEnabled()) {
    const list = await priorities(creds);
    const edit = editOf(offered, { start: ids?.start, flag: ids?.flag }, list.ok && list.data ? list.data : null, v, isObj(r.data) && isObj(r.data.fields) ? r.data.fields : undefined);
    if (edit) read.detail.edit = edit;
  }
  return { ok: true, data: read };
}

/**
 * Which comment answers which, on Cloud. The comments inside an issue read carry no `parentId` (measured on a real
 * site; only the comment list does), so a card with comments costs one more request to draw its threads. It asks for as
 * many as the issue read carried, in the same order, and a failure leaves the comments flat rather than failing the card.
 */
async function threadParents(creds: JiraCreds, key: string, rows: TaskDetail["comments"]): Promise<void> {
  const r = await jiraCall<unknown>(creds, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=${Math.min(rows.length, 100)}`);
  const list = r.ok && isObj(r.data) && Array.isArray(r.data.comments) ? r.data.comments : [];
  const parent = new Map<string, string>();
  // `id` is a string and `parentId` a number on a real site; either is read as text.
  for (const c of list) if (isObj(c) && idText(c.id) && idText(c.parentId)) parent.set(idText(c.id), idText(c.parentId));
  for (const row of rows) { const p = parent.get(row.id); if (p) row.parentId = p; }
}

export interface MentionPerson { key: string; name: string; initials: string; avatar?: string }

/**
 * Who can be named on this card, for what was typed after `@`. Jira's people
 * search answers fewer than asked (it scans a slice of the directory, then
 * filters), so a short answer is not "nobody else": the next letter asks again.
 */
export function mentionable(creds: JiraCreds, key: string, q: string): Promise<JiraResult<MentionPerson[]>> {
  if (!ISSUE_KEY.test(key)) return Promise.resolve({ ok: false, error: "That is not a Jira card id" });
  const query = q.trim().slice(0, 64);
  const v = apiOf(creds);
  return memoOk<MentionPerson[]>(creds, `people|${key.toUpperCase()}|${query.toLowerCase()}`, async () => {
    // Data Center takes the text as `username`; Cloud as `query`.
    const p = new URLSearchParams({ issueKey: key.toUpperCase(), [v === 3 ? "query" : "username"]: query, maxResults: String(PEOPLE_PAGE) });
    const r = await jiraCall<unknown>(creds, `/rest/api/${v}/user/assignable/search?${p}`);
    if (!r.ok) return { ...r, data: undefined };
    const people: MentionPerson[] = [];
    for (const u of Array.isArray(r.data) ? r.data.filter(isObj) : []) {
      const handle = handleOf(u, v);
      const name = str(u.displayName) || str(u.name);
      if (!handle || !name || !(v === 3 ? ACCOUNT_ID : LOGIN).test(handle)) continue;
      const avatar = avatarOf(u);
      people.push({ key: handle, name, initials: initialsOf(name), ...(avatar ? { avatar } : {}) });
    }
    return { ok: true, data: people };
  });
}

/** The body a comment is sent with, in the format this site speaks. */
export function commentBody(markdown: string, mentions: Mention[], v: 2 | 3): { body: unknown } {
  return { body: v === 3 ? markdownToAdf(markdown, mentions) : markdownToWiki(markdown, mentions) };
}

const COMMENT_ID = /^\d{1,12}$/;

/** The sentence for a comment Jira refused with a 400: its own words are never passed on. */
const NOT_ACCEPTED = "Jira did not accept that comment";

export type CommentOutcome = WriteOutcome & { detail?: TaskDetail; more?: number };

/**
 * Write one comment and give back the card as it is afterwards. No retry: a
 * second POST is a second comment. Nothing is compared first, because a
 * comment cannot conflict with an edit; the read afterwards brings the new
 * `updated` so the next move is checked against the card as it now is.
 */
export async function commentOn(creds: JiraCreds, key: string, markdown: string, rawMentions: unknown, replyTo?: unknown): Promise<CommentOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: "Writing to Jira is switched off" };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  // A reply is Cloud's `parentId`; Data Center's REST has no thread, and a reply sent as a plain comment would not be one.
  if (replyTo !== undefined && replyTo !== null && replyTo !== "") {
    if (apiOf(creds) !== 3) return { ok: false, error: "This Jira does not thread comments: add a comment instead" };
    if (typeof replyTo !== "string" || !COMMENT_ID.test(replyTo)) return { ok: false, error: "That is not a comment this card has" };
  }
  const text = typeof markdown === "string" ? markdown.trim() : "";
  if (!text) return { ok: false, error: "Write something first" };
  if (text.length > MAX_COMMENT) return { ok: false, error: "That comment is too long for Jira" };
  const v = apiOf(creds);
  const body = commentBody(text, readMentions(rawMentions, v), v);
  if (v === 3 ? !(body.body as { content: unknown[] }).content.length : !str(body.body).trim()) return { ok: false, error: "Write something first" };
  const upper = key.toUpperCase();
  const parent = typeof replyTo === "string" && replyTo ? { parentId: replyTo } : {};
  const post = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/comment`, { method: "POST", body: { ...body, ...parent } });
  if (!post.ok) {
    if (post.status === 400) return { ok: false, error: parent.parentId ? "Jira did not accept that reply: the comment may have been deleted" : NOT_ACCEPTED };
    if (post.status === 403) return { ok: false, error: `Your Jira account cannot comment on ${upper}` };
    // No answer, or a server error, says nothing about whether it landed, and
    // sending the kept draft again would be a second comment.
    if (!post.throttled && !post.unauthorised && (post.status === undefined || post.status >= 500)) {
      return { ok: false, error: `${post.error ?? "Jira did not answer"}. The comment may have been posted: reload the card before sending it again` };
    }
    return { ok: false, unauthorised: post.unauthorised, error: post.error };
  }
  // The card is read back for its stamp and its count; who answers whom is not asked again (the pane keeps what it knew).
  const back = await readDetail(creds, upper, { fresh: true, threads: false });
  if (!back.ok || !back.data) return { ok: true, partial: "The comment was posted, but the card could not be read back. Reload it." };
  return { ok: true, task: back.data.detail.task, detail: back.data.detail, more: back.data.more };
}

export type CommentEdit = WriteOutcome & { comment?: TaskDetail["comments"][number]; removed?: boolean };

/** The comment, when it is the connected account's own; otherwise the sentence that stops the write. One request. */
async function ownComment(creds: JiraCreds, upper: string, id: string): Promise<{ raw: Record<string, unknown>; me: string } | { stop: CommentEdit }> {
  const v = apiOf(creds);
  const [r, cx] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/comment/${id}`, { fresh: true }),
    taskContext(creds),
  ]);
  if (!r.ok || !isObj(r.data)) return { stop: { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not check the comment first. ${r.error ?? "Jira did not answer"}` } };
  const author = isObj(r.data.author) ? personId(r.data.author) : "";
  if (!cx.me || !author) return { stop: { ok: false, error: "Nothing was changed: could not tell whose comment this is" } };
  if (author !== cx.me) return { stop: { ok: false, error: "That comment is somebody else's: only your own can be changed here" } };
  return { raw: r.data, me: cx.me };
}

/** Why Jira refused a comment edit or delete, in our words. */
function commentRefusal(r: JiraResult<unknown>, what: string): CommentEdit {
  if (r.status === 400) return { ok: false, error: `Jira did not accept that ${what}` };
  if (r.status === 403) return { ok: false, error: `Your Jira account cannot ${what} that comment` };
  if (r.status === 404) return { ok: false, error: "That comment is gone: reload the card" };
  return { ok: false, unauthorised: r.unauthorised, error: r.error };
}

/**
 * Change your own comment. Two requests: the comment (it must be yours, and
 * it must still be there), then the PUT, whose answer is the comment as it now
 * stands. The card's `updated` moved with it, so the pane reads the card again
 * rather than this reading it a third time.
 */
export async function editComment(creds: JiraCreds, key: string, id: string, markdown: string, rawMentions: unknown): Promise<CommentEdit> {
  if (!jiraWriteEnabled()) return { ok: false, error: "Writing to Jira is switched off" };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (typeof id !== "string" || !COMMENT_ID.test(id)) return { ok: false, error: "That is not a comment this card has" };
  const text = typeof markdown === "string" ? markdown.trim() : "";
  if (!text) return { ok: false, error: "A comment cannot be empty: delete it instead" };
  if (text.length > MAX_COMMENT) return { ok: false, error: "That comment is too long for Jira" };
  const v = apiOf(creds);
  const upper = key.toUpperCase();
  const own = await ownComment(creds, upper, id);
  if ("stop" in own) return own.stop;
  // No list at all (an agent that only sent words) keeps the people the comment already names; a list, even an empty one, is the caller's say.
  const roster = rawMentions === undefined ? fullReader(v, {})(own.raw.body).mentions : readMentions(rawMentions, v);
  const body = commentBody(text, roster, v);
  if (v === 3 ? !(body.body as { content: unknown[] }).content.length : !str(body.body).trim()) return { ok: false, error: "A comment cannot be empty: delete it instead" };
  const put = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/comment/${id}`, { method: "PUT", body });
  if (!put.ok) return commentRefusal(put, "change");
  const rows = isObj(put.data) ? commentRows([put.data], v, own.me, [put.data.author]).comments : [];
  return rows[0] ? { ok: true, comment: rows[0] } : { ok: true, partial: "The comment was changed, but could not be read back. Reload it." };
}

/** Delete your own comment. Two requests: the comment, then the DELETE. The thread's replies stay where Jira keeps them. */
export async function deleteComment(creds: JiraCreds, key: string, id: string): Promise<CommentEdit> {
  if (!jiraWriteEnabled()) return { ok: false, error: "Writing to Jira is switched off" };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (typeof id !== "string" || !COMMENT_ID.test(id)) return { ok: false, error: "That is not a comment this card has" };
  const upper = key.toUpperCase();
  const own = await ownComment(creds, upper, id);
  if ("stop" in own) return own.stop;
  const del = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/comment/${id}`, { method: "DELETE" });
  if (!del.ok) return commentRefusal(del, "delete");
  return { ok: true, removed: true };
}

// What the routes call: the stored connection, or the sentence that says there is none.
export const detailStored = (key: string): Promise<JiraResult<JiraDetail>> => withStored((c) => readDetail(c, key));
export const mentionableStored = (key: string, q: string): Promise<JiraResult<MentionPerson[]>> => withStored((c) => mentionable(c, key, q));
export async function commentStored(key: string, markdown: string, mentions: unknown, replyTo?: unknown): Promise<CommentOutcome> {
  const r = await withStored(async (c) => ({ ok: true, data: await commentOn(c, key, markdown, mentions, replyTo) }));
  return r.ok && r.data ? r.data : { ok: false, error: r.error ?? "Jira is not connected" };
}
export async function editCommentStored(key: string, id: string, markdown: string, mentions: unknown): Promise<CommentEdit> {
  const r = await withStored(async (c) => ({ ok: true, data: await editComment(c, key, id, markdown, mentions) }));
  return r.ok && r.data ? r.data : { ok: false, error: r.error ?? "Jira is not connected" };
}
export async function deleteCommentStored(key: string, id: string): Promise<CommentEdit> {
  const r = await withStored(async (c) => ({ ok: true, data: await deleteComment(c, key, id) }));
  return r.ok && r.data ? r.data : { ok: false, error: r.error ?? "Jira is not connected" };
}
