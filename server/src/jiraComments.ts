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
 * Ceiling: comments are not edited or deleted here, replies and reactions do
 * not exist in Jira's REST API, and a card with more comments than the issue
 * read carries says how many were left out rather than paging for them.
 */
import { CARD_FIELDS, apiOf, jiraCall, jiraWriteEnabled, memoOk, taskContext, toTask, withStored, type JiraCreds, type JiraResult } from "./jira.ts";
import { adfToMarkdown, markdownToAdf, markdownToWiki, wikiToMarkdown, type Mention } from "./jiraAdf.ts";
import type { TaskDetail, ProviderTask } from "../../shared/providers.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const epoch = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };
const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
/** Jira's own limit is 32,767 characters; Markdown grows a little on the way. */
const MAX_COMMENT = 30_000;
const PEOPLE_PAGE = 20;
const MAX_MENTIONS = 50;
/** A Cloud account id (`5b10a2844c20165700ede21g`, `712020:2b6e...`). */
const ACCOUNT_ID = /^[A-Za-z0-9:._-]{1,128}$/;
/** A Data Center login, as it goes inside `[~name]`. */
const LOGIN = /^[^\s[\]|~{}]{1,255}$/;

/** Who a person is to Jira: Cloud names them by account id, Data Center by key, then login. */
const personId = (u: Record<string, unknown>): string => str(u.accountId) || str(u.key) || str(u.name);
/** What a mention carries: the account id on Cloud, the login on Data Center. */
const handleOf = (u: Record<string, unknown>, v: 2 | 3): string => (v === 3 ? str(u.accountId) : str(u.name));
const avatarOf = (u: Record<string, unknown>): string | undefined => {
  const a = isObj(u.avatarUrls) ? str(u.avatarUrls["48x48"]) : "";
  return a.startsWith("https://") ? a : undefined;
};

/** The card's description and comments, as Markdown, from one issue read. */
export function toDetail(issue: unknown, task: ProviderTask, v: 2 | 3, me?: string): { detail: TaskDetail; more: number } {
  const f = isObj(issue) && isObj(issue.fields) ? issue.fields : {};
  const box = isObj(f.comment) ? f.comment : {};
  const raw = (Array.isArray(box.comments) ? box.comments : []).filter(isObj);
  // A login inside `[~ada]` is shown by the name the same answer gave it
  // (the assignee, or somebody who commented); anyone else by the login.
  const names: Record<string, string> = {};
  for (const u of [f.assignee, ...raw.map((c) => c.author)]) {
    if (isObj(u) && str(u.name) && str(u.displayName)) names[str(u.name)] = str(u.displayName);
  }
  const read = (body: unknown) => (v === 3 ? adfToMarkdown(body) : wikiToMarkdown(body, names));
  const comments: TaskDetail["comments"] = raw.map((c) => {
    const a = isObj(c.author) ? c.author : {};
    const who = str(a.displayName) || str(a.name) || "Someone";
    const avatar = avatarOf(a);
    return {
      id: str(c.id) || String(c.id ?? ""),
      who,
      text: read(c.body).text,
      at: epoch(c.created),
      initials: initialsOf(who),
      ...(avatar ? { avatar } : {}),
      ...(me && personId(a) === me ? { mine: true } : {}),
    };
  }).filter((c) => c.id).sort((x, y) => x.at - y.at);
  const total = typeof box.total === "number" ? box.total : comments.length;
  return {
    detail: { task, description: f.description == null ? "" : read(f.description).text, subtasks: [], checklists: [], comments },
    more: Math.max(0, total - comments.length),
  };
}

export interface JiraDetail { detail: TaskDetail; more: number }

/** One card with its words. One request, plus the priority list when it is not remembered. */
export async function readDetail(creds: JiraCreds, key: string, o: { fresh?: boolean } = {}): Promise<JiraResult<JiraDetail>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const v = apiOf(creds);
  const fields = [...CARD_FIELDS, "description", "comment"].join(",");
  const [r, cx] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=${fields}`, { fresh: o.fresh }),
    taskContext(creds),
  ]);
  if (!r.ok) return { ...r, data: undefined };
  const task = toTask(r.data, cx);
  if (!task) return { ok: false, error: "Jira answered with something that is not a card" };
  return { ok: true, data: toDetail(r.data, task, v, cx.me) };
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

/** The people a comment names, as the caller sent them; anything malformed is dropped. */
export function readMentions(raw: unknown, v: 2 | 3): Mention[] {
  if (!Array.isArray(raw)) return [];
  const out: Mention[] = [];
  for (const m of raw.slice(0, MAX_MENTIONS)) {
    if (!isObj(m)) continue;
    const id = str(m.id), name = str(m.name).trim();
    if (!(v === 3 ? ACCOUNT_ID : LOGIN).test(id) || !name || name.length > 100 || /[\n\r]/.test(name)) continue;
    out.push({ id, name });
  }
  return out;
}

/** The body a comment is sent with, in the format this site speaks. */
export function commentBody(markdown: string, mentions: Mention[], v: 2 | 3): { body: unknown } {
  return { body: v === 3 ? markdownToAdf(markdown, mentions) : markdownToWiki(markdown, mentions) };
}

/** The sentence for a comment Jira refused with a 400: its own words are never passed on. */
const NOT_ACCEPTED = "Jira did not accept that comment";

export type CommentOutcome = WriteOutcome & { detail?: TaskDetail; more?: number };

/**
 * Write one comment and give back the card as it is afterwards. No retry: a
 * second POST is a second comment. Nothing is compared first, because a
 * comment cannot conflict with an edit; the read afterwards brings the new
 * `updated` so the next move is checked against the card as it now is.
 */
export async function commentOn(creds: JiraCreds, key: string, markdown: string, rawMentions: unknown): Promise<CommentOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: "Writing to Jira is switched off" };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const text = typeof markdown === "string" ? markdown.trim() : "";
  if (!text) return { ok: false, error: "Write something first" };
  if (text.length > MAX_COMMENT) return { ok: false, error: "That comment is too long for Jira" };
  const v = apiOf(creds);
  const body = commentBody(text, readMentions(rawMentions, v), v);
  if (v === 3 ? !(body.body as { content: unknown[] }).content.length : !str(body.body).trim()) return { ok: false, error: "Write something first" };
  const upper = key.toUpperCase();
  const post = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}/comment`, { method: "POST", body });
  if (!post.ok) {
    if (post.status === 400) return { ok: false, error: NOT_ACCEPTED };
    if (post.status === 403) return { ok: false, error: `Your Jira account cannot comment on ${upper}` };
    // No answer, or a server error, says nothing about whether it landed, and
    // sending the kept draft again would be a second comment.
    if (!post.throttled && !post.unauthorised && (post.status === undefined || post.status >= 500)) {
      return { ok: false, error: `${post.error ?? "Jira did not answer"}. The comment may have been posted: reload the card before sending it again` };
    }
    return { ok: false, unauthorised: post.unauthorised, error: post.error };
  }
  const back = await readDetail(creds, upper, { fresh: true });
  if (!back.ok || !back.data) return { ok: true, partial: "The comment was posted, but the card could not be read back. Reload it." };
  return { ok: true, task: back.data.detail.task, detail: back.data.detail, more: back.data.more };
}

// What the routes call: the stored connection, or the sentence that says there is none.
export const detailStored = (key: string): Promise<JiraResult<JiraDetail>> => withStored((c) => readDetail(c, key));
export const mentionableStored = (key: string, q: string): Promise<JiraResult<MentionPerson[]>> => withStored((c) => mentionable(c, key, q));
export async function commentStored(key: string, markdown: string, mentions: unknown): Promise<CommentOutcome> {
  const r = await withStored(async (c) => ({ ok: true, data: await commentOn(c, key, markdown, mentions) }));
  return r.ok && r.data ? r.data : { ok: false, error: r.error ?? "Jira is not connected" };
}
