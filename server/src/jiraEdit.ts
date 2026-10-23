/*
 * Changing the Details of a Jira card: title, priority, labels, due and start
 * date, parent, the flag and the two estimates.
 *
 * What a write may carry is decided here, in `planEdit`, before anything is
 * sent. Three rules, each one a thing that went wrong on a real site:
 *
 *   - A field the card's `editmeta` does not list is refused. The API accepts
 *     some of those (it took `components` and `timetracking` on a project that
 *     hides them), and a write by NAME to a field with no such option CREATED
 *     the option in the project. So an option field goes by the id the site
 *     offered, and a field the site did not offer is not written at all.
 *   - Clearing is field-specific: a date and the flag take `null`; an estimate
 *     takes the empty string, because `null` is answered 204 and changes
 *     nothing; labels are `add` / `remove` operations so another person's
 *     concurrent label is not overwritten.
 *   - Jira's own error text is never passed on. A 400 is "Jira did not take
 *     that value".
 *
 * Requests, counted: one edit is three. A read of the card's `updated` (the
 * stamp; a stamp that moved is a conflict and nothing is sent), the PUT, and a
 * read of the card as it now stands. Cloud's `returnIssue` does not shorten it:
 * measured on a real site, the answer carries only the fields the PUT changed
 * and no `updated`, so it cannot be the next stamp. When the card was opened
 * here the list of editable fields is remembered and a field outside it is
 * refused with no request at all; otherwise the stamp read carries
 * `expand=editmeta` and the refusal comes before the PUT.
 *
 * Ceiling: one field per edit, so an undo is one more edit. Parent is Cloud's
 * (`parent`); on Data Center an epic is a custom field and is left to Jira.
 * Priorities are the site's list, not the per-project scheme. Label
 * suggestions are the first page Jira's autocomplete gives for what was typed.
 */
import {
  CARD_FIELDS, ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, cardPointsField, epoch, jiraCall, jiraWriteEnabled, memoOk, priorities, siteFields, stale, unreadable, storedCreds,
  taskContext, toTask, withStored, type JiraCreds, type JiraFieldIds, type JiraPriorities, type JiraResult,
} from "./jira.ts";
import { editableBody, markdownToAdf, markdownToWiki, readMentions } from "./jiraAdf.ts";
import { factsOf, fullReader, offeredFields, textReader } from "./jiraCardRead.ts";
import type { CardEdit, CardFact } from "../../shared/providers.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The edits this module knows. Anything else is refused by name. */
export const EDIT_FIELDS = ["summary", "description", "priority", "labels", "duedate", "start", "parent", "flag", "originalEstimate", "remainingEstimate"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

/** What Jira's flag field takes to mean "flagged". */
export const FLAG_VALUE = "Impediment";
const MAX_TITLE = 255;
/** Jira's own limit is 32,767 characters; Markdown grows a little on the way. */
const MAX_DESCRIPTION = 30_000;
const PRIORITY_ID = /^\d{1,9}$/;
const LABEL = /^[^\s,]{1,255}$/;
/** "2h 30m", "1w 2d": the units Jira's time tracking reads. */
const ESTIMATE = /^(?:\d{1,4}[wdhm])(?: ?\d{1,4}[wdhm]){0,3}$/;

/** A real calendar day as `YYYY-MM-DD`. */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface EditAsk { field: unknown; value?: unknown; add?: unknown; remove?: unknown; /** The people a description names, as a comment sends them. */ mentions?: unknown }
export interface EditIds { start?: string; flag?: string }
export type Plan =
  | { ok: true; field: EditField; /** The key `editmeta.fields` must list for this write. */ gate: string; body: Record<string, unknown> }
  | { ok: false; error: string };

const no = (error: string): Plan => ({ ok: false, error });

/** The request body for one edit, or the sentence that says why none is sent. */
export function planEdit(ask: EditAsk, ids: EditIds, v: 2 | 3): Plan {
  const field = ask.field;
  if (typeof field !== "string" || !(EDIT_FIELDS as readonly string[]).includes(field)) return no("That is not something this card lets you change here");
  switch (field as EditField) {
    case "summary": {
      const t = typeof ask.value === "string" ? ask.value.trim() : "";
      if (!t) return no("A card needs a title");
      if (/[\r\n]/.test(t)) return no("A title is one line");
      if (t.length > MAX_TITLE) return no(`A title is at most ${MAX_TITLE} characters`);
      return { ok: true, field: "summary", gate: "summary", body: { fields: { summary: t } } };
    }
    case "description": {
      // Markdown in, the site's own format out. Empty takes the description off: `null` clears it on both flavours.
      if (typeof ask.value !== "string") return no("A description is text");
      const t = ask.value.trim();
      if (t.length > MAX_DESCRIPTION) return no("That description is too long for Jira");
      if (!t) return { ok: true, field: "description", gate: "description", body: { fields: { description: null } } };
      const roster = readMentions(ask.mentions, v);
      return { ok: true, field: "description", gate: "description", body: { fields: { description: v === 3 ? markdownToAdf(t, roster) : markdownToWiki(t, roster) } } };
    }
    case "priority": {
      if (typeof ask.value !== "string" || !PRIORITY_ID.test(ask.value)) return no("That is not a priority this site offers");
      return { ok: true, field: "priority", gate: "priority", body: { fields: { priority: { id: ask.value } } } };
    }
    case "labels": {
      const add = ask.add, remove = ask.remove;
      if ((add === undefined) === (remove === undefined)) return no("Add one label or take one off, not both");
      const name = add !== undefined ? add : remove;
      if (typeof name !== "string" || !LABEL.test(name)) return no("A label is one word, without spaces or commas");
      return { ok: true, field: "labels", gate: "labels", body: { update: { labels: [add !== undefined ? { add: name } : { remove: name }] } } };
    }
    case "duedate": {
      if (ask.value !== null && !isDay(ask.value)) return no("That is not a date");
      return { ok: true, field: "duedate", gate: "duedate", body: { fields: { duedate: ask.value } } };
    }
    case "start": {
      if (!ids.start) return no("This site has no start date field");
      if (ask.value !== null && !isDay(ask.value)) return no("That is not a date");
      return { ok: true, field: "start", gate: ids.start, body: { fields: { [ids.start]: ask.value } } };
    }
    case "parent": {
      if (v !== 3) return no("Change the parent in Jira: this site keeps it in a field the app does not write");
      if (ask.value === null) return { ok: true, field: "parent", gate: "parent", body: { fields: { parent: null } } };
      if (typeof ask.value !== "string" || !ISSUE_KEY.test(ask.value.trim())) return no("A parent is a card id, like ORBIT-1042");
      return { ok: true, field: "parent", gate: "parent", body: { fields: { parent: { key: ask.value.trim().toUpperCase() } } } };
    }
    case "flag": {
      if (!ids.flag) return no("This site has no flag field");
      if (typeof ask.value !== "boolean") return no("A card is flagged or it is not");
      return { ok: true, field: "flag", gate: ids.flag, body: { fields: { [ids.flag]: ask.value ? [{ value: FLAG_VALUE }] : null } } };
    }
    case "originalEstimate":
    case "remainingEstimate": {
      // The empty string clears; `null` is accepted by Jira and silently changes nothing.
      const t = typeof ask.value === "string" ? ask.value.trim() : null;
      if (t === null || (t !== "" && !ESTIMATE.test(t))) return no("An estimate is written like 2h 30m (weeks w, days d, hours h, minutes m)");
      return { ok: true, field: field as EditField, gate: "timetracking", body: { fields: { timetracking: { [field]: t } } } };
    }
  }
}

/** The edit keys this card's edit screen offers, for the pane to draw controls from. Null when the site named no fields. */
export function editOf(offered: Set<string> | null, ids: EditIds, list: JiraPriorities | null, v: 2 | 3, card?: Record<string, unknown>): CardEdit | null {
  if (!offered) return null;
  const fields: string[] = [];
  for (const f of ["summary", "priority", "labels", "duedate"]) if (offered.has(f)) fields.push(f);
  // The description is offered for editing only when Markdown can hold all of it; otherwise the pane says so and points at Jira.
  let descriptionLocked = false;
  if (offered.has("description") && card && "description" in card) {
    if (editableBody(card.description, v)) fields.push("description"); else descriptionLocked = true;
  }
  if (v === 3 && offered.has("parent")) fields.push("parent");
  if (ids.start && offered.has(ids.start)) fields.push("start");
  if (ids.flag && offered.has(ids.flag)) fields.push("flag");
  if (offered.has("timetracking")) fields.push("originalEstimate", "remainingEstimate");
  const options = list ? list.ids.map((id, i) => ({ id, name: list.names[i] ?? id })) : [];
  const now = card && isObj(card.priority) && str(card.priority.id) ? { id: str(card.priority.id), name: str(card.priority.name) || str(card.priority.id) } : null;
  return { fields, priorities: offered.has("priority") ? options : [], ...(now ? { priority: now } : {}), reply: v === 3, ...(descriptionLocked ? { descriptionLocked } : {}) };
}

// --- what a card's edit screen listed when it was opened here ---------------

const OFFER_TTL_MS = 10 * 60_000;
const offers = new Map<string, { set: Set<string>; at: number }>();
export function rememberOffered(key: string, set: Set<string> | null): void {
  if (set) offers.set(key.toUpperCase(), { set, at: Date.now() });
}
const offeredFor = (key: string): Set<string> | null => {
  const o = offers.get(key.toUpperCase());
  return o && Date.now() - o.at < OFFER_TTL_MS ? o.set : null;
};
export const __forgetOffered = (): void => offers.clear();

/** Said when the stored description has parts Markdown would lose. */
export const HOLDS_MORE = "This description has parts Markdown cannot keep (a table, a panel, an image or a colour). Open it in Jira to change it";
const NOT_OFFERED = "This card does not let you change that here";

export type EditOutcome = WriteOutcome & { facts?: CardFact[]; edit?: CardEdit; /** The description as it now stands, in Markdown. */ description?: string };

/** Why Jira refused an edit, in our words. */
function refusal(r: JiraResult<unknown>): EditOutcome {
  if (r.status === 400) return { ok: false, error: "Jira did not take that value" };
  if (r.status === 403) return { ok: false, error: "Your Jira account cannot edit this card" };
  if (r.status === 409) return stale();
  return { ok: false, unauthorised: r.unauthorised, error: r.error };
}

/** The fields a card's read after an edit asks for: the board's, and what the Details are drawn from. */
export function readFields(ids: JiraFieldIds | null): string {
  const more = [ids?.start, ids?.flag, ids?.team, ids?.sprint, cardPointsField(ids)].filter((x): x is string => !!x);
  return [...CARD_FIELDS, "parent", "reporter", "issuetype", "components", "fixVersions", "versions", "timetracking", ...more].join(",");
}

/**
 * Change one field of a card. The write switch, the inputs, the plan, the
 * editmeta gate, a read of `updated` (a conflict when it is not the one the
 * person saw), the PUT, and the card as it is afterwards.
 */
export async function editCard(creds: JiraCreds, key: string, ask: EditAsk, updated: number): Promise<EditOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (!Number.isFinite(updated) || updated <= 0) return { ok: false, error: "Nothing was changed: reload the card and try again" };
  const v = apiOf(creds);
  const found = await siteFields(creds);
  const ids = found.ok && found.data ? found.data : null;
  const first = planEdit(ask, { start: ids?.start, flag: ids?.flag }, v);
  if (!first.ok) return first;
  let plan = first;
  const upper = key.toUpperCase();
  const known = offeredFor(upper);
  if (known && !known.has(plan.gate)) return { ok: false, error: NOT_OFFERED };

  const seen = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}?fields=updated${plan.field === "description" ? ",description" : ""}${known ? "" : "&expand=editmeta"}`, { fresh: true });
  if (!seen.ok) return { ok: false, unauthorised: seen.unauthorised, error: `Nothing was changed: could not check the card first. ${seen.error ?? "Jira did not answer"}` };
  const offered = known ?? offeredFields(seen.data);
  if (!offered) return { ok: false, error: "Nothing was changed: Jira did not say which fields this card lets you change" };
  if (!offered.has(plan.gate)) return { ok: false, error: NOT_OFFERED };
  const now = epoch(isObj(seen.data) && isObj(seen.data.fields) ? seen.data.fields.updated : undefined);
  if (!now) return unreadable();
  if (now !== updated) return stale();

  // A description that Markdown cannot hold whole is not rewritten from Markdown: that is how a table or a panel is flattened.
  if (plan.field === "description") {
    const stored = isObj(seen.data) && isObj(seen.data.fields) ? seen.data.fields.description : undefined;
    if (!editableBody(stored, v)) return { ok: false, error: HOLDS_MORE };
    // Words with no list of people keep the people the description already names, as a comment's edit does.
    if (ask.mentions === undefined) {
      const again = planEdit({ ...ask, mentions: fullReader(v, {})(stored ?? null).mentions }, { start: ids?.start, flag: ids?.flag }, v);
      if (again.ok) plan = again;
    }
  }

  const fields = plan.field === "description" ? `${readFields(ids)},description` : readFields(ids);
  const base = `/rest/api/${v}/issue/${encodeURIComponent(upper)}`;
  const put = await jiraCall<unknown>(creds, base, { method: "PUT", body: plan.body });
  if (!put.ok) return refusal(put);
  const back = await jiraCall<unknown>(creds, `${base}?fields=${fields}`, { fresh: true });
  const cx = { ...(await taskContext(creds)), fields: { sprint: ids?.sprint, points: cardPointsField(ids) } };
  const task = back.ok ? toTask(back.data, cx) : null;
  if (!task || !isObj(back.data) || !isObj(back.data.fields)) {
    return { ok: false, error: `The card was changed, but could not be read back. Reload it. ${back.error ?? ""}`.trim() };
  }
  const list = await priorities(creds);
  const facts = factsOf(back.data.fields, { start: ids?.start, flag: ids?.flag, team: ids?.team }, offered);
  const edit = editOf(offered, { start: ids?.start, flag: ids?.flag }, list.ok && list.data ? list.data : null, v, back.data.fields);
  return { ok: true, task, facts, ...(edit ? { edit } : {}), ...(plan.field === "description" ? { description: textReader(v, {})(back.data.fields.description ?? null) } : {}) };
}

export async function editStored(key: string, ask: EditAsk, updated: number): Promise<EditOutcome> {
  const c = storedCreds();
  return c ? editCard(c, key, ask, updated) : { ok: false, error: NOT_CONNECTED };
}

// --- label suggestions -------------------------------------------------------

/**
 * Labels the site knows that start with what was typed: one read per typed
 * query, kept ten minutes. Cloud has no label search in its REST, so this is
 * the JQL autocomplete's answer; Data Center has its own suggest route.
 */
export function labelSuggestions(creds: JiraCreds, q: string): Promise<JiraResult<string[]>> {
  const query = q.trim().slice(0, 64);
  const v = apiOf(creds);
  return memoOk<string[]>(creds, `labels|${query.toLowerCase()}`, async () => {
    const path = v === 3
      ? `/rest/api/3/jql/autocompletedata/suggestions?${new URLSearchParams({ fieldName: "labels", fieldValue: query })}`
      : `/rest/api/1.0/labels/suggest?${new URLSearchParams({ query })}`;
    const r = await jiraCall<unknown>(creds, path);
    if (!r.ok) return { ...r, data: undefined };
    const rows = isObj(r.data) ? (v === 3 ? r.data.results : r.data.suggestions) : [];
    const names = (Array.isArray(rows) ? rows : []).flatMap((x) => {
      const n = isObj(x) ? str(x.value) || str(x.label) : "";
      return LABEL.test(n) ? [n] : [];
    });
    return { ok: true, data: names.slice(0, 50) };
  });
}
export const labelSuggestionsStored = (q: string): Promise<JiraResult<string[]>> => withStored((c) => labelSuggestions(c, q));
