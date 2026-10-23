/*
 * What a Jira card is joined to, changed from the pane: a sub-task made under
 * it, another card linked or unlinked, a web address added or taken off.
 * (A sub-task's status is the card's own move, `moveStored`.)
 *
 * Every write is behind the Jira write switch, and every one is built on ids the
 * site gave, never on a name a person typed:
 *
 *   - A sub-task is made with the id of the project's sub-task type, read from
 *     the site's create metadata once per project and remembered. The project
 *     is the card's own key without its number.
 *   - A link is made with the id of a link type from the site's list, and says
 *     which side the card is on. Measured on a real site: `inwardIssue` is the
 *     card that holds the OUTWARD phrase, so "A blocks B" is `inwardIssue` A and
 *     `outwardIssue` B. A link already there (same type, same side, same card)
 *     is left alone, so a second press never makes a second link.
 *   - Taking a link off, or a web address, is by id, and the id must be one of
 *     THIS card's own: the site's delete takes any link on the site by id, so the
 *     card is read first and an id it does not hold is refused. Neither is
 *     offered without the person being asked first (the screen) or saying they
 *     mean it (the door).
 *   - A web address is `http` or `https` with no password in it; `javascript:`,
 *     `file:` and the rest are refused before any request.
 *
 * Requests, counted: a sub-task is the card's type list (once per project), the
 * POST and the card read back. A link is the card's links, the POST and the card
 * read back; taking one off is the same with a DELETE. A web address is the
 * card's links, then the POST (the new row is built from its answer); taking one
 * off is the links and the DELETE. Jira's own error text never reaches the answer.
 *
 * Ceilings, on purpose: one sub-task type per project (the first the site lists
 * as one); a link needs the other card's key, which the screen finds with the
 * board's own search; a web address's title is what was typed, or its host, and
 * is not refreshed afterwards; a sub-task made while the site is slow to answer
 * may exist even when the answer says it does not, so a failed create names that.
 */
import {
  ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, idText, jiraCall, jiraWriteEnabled, memoOk, storedCreds, withStored,
  type JiraCreds, type JiraResult,
} from "./jira.ts";
import { readDetail } from "./jiraComments.ts";
import { webLinksOf } from "./jiraCardRead.ts";
import type { CardWebLink, TaskDetail } from "../../shared/providers.ts";
import type { WriteOutcome } from "./trackerTypes.ts";
import { hasUrlCredentials } from "../../shared/urlCredentials.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What a write here gives back: the card as it now stands, or the whole list of its web addresses. */
export type RelateOutcome = WriteOutcome & {
  detail?: TaskDetail; more?: number; web?: CardWebLink[];
  /** The card or address was already as asked: nothing was sent. */
  already?: boolean;
  /** The key of the sub-task that was made. */
  created?: string;
};

const no = (error: string): RelateOutcome => ({ ok: false, error });
const MAX_TITLE = 255;
const MAX_URL = 2000;
const MAX_LABEL = 200;
const ID = /^\d{1,12}$/;

/** One link type the site has, in the words of each side. */
export interface LinkKind { id: string; name: string; inward: string; outward: string }

/** The site's link types, remembered for ten minutes: the picker and every link write ask the same list. */
export function linkKinds(creds: JiraCreds): Promise<JiraResult<LinkKind[]>> {
  return memoOk<LinkKind[]>(creds, "linkkinds", async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issueLinkType`);
    if (!r.ok) return { ...r, data: undefined };
    const raw = isObj(r.data) && Array.isArray(r.data.issueLinkTypes) ? r.data.issueLinkTypes : [];
    const out: LinkKind[] = [];
    for (const t of raw) {
      if (!isObj(t)) continue;
      const id = idText(t.id);
      if (ID.test(id) && str(t.name) && str(t.outward) && str(t.inward)) out.push({ id, name: str(t.name), inward: str(t.inward), outward: str(t.outward) });
    }
    return { ok: true, data: out };
  });
}
export const linkKindsStored = (): Promise<JiraResult<LinkKind[]>> => withStored((c) => linkKinds(c));

/** The project a key belongs to: everything before its number. */
const projectOf = (key: string): string => key.slice(0, key.lastIndexOf("-"));

/** The id of the project's sub-task type, from the site's create metadata, remembered per project. */
async function subtaskType(creds: JiraCreds, project: string): Promise<JiraResult<string>> {
  return memoOk<string>(creds, `subtask|${project}`, async () => {
    const v = apiOf(creds);
    const r = v === 3
      ? await jiraCall<unknown>(creds, `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes?maxResults=100`)
      : await jiraCall<unknown>(creds, `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(project)}&expand=projects.issuetypes`);
    if (!r.ok) return { ...r, data: undefined };
    const types = !isObj(r.data) ? []
      : v === 3 ? (Array.isArray(r.data.issueTypes) ? r.data.issueTypes : [])
      : (Array.isArray(r.data.projects) && isObj(r.data.projects[0]) && Array.isArray(r.data.projects[0].issuetypes) ? r.data.projects[0].issuetypes : []);
    const sub = types.find((t) => isObj(t) && t.subtask === true && ID.test(idText(t.id)));
    return isObj(sub) ? { ok: true, data: idText(sub.id) } : { ok: false, error: "This project has no sub-task type" };
  }, true);
}

/** Jira's refusal of a write here, in our words. */
export function refusal(r: JiraResult<unknown>, what: string, who: string): RelateOutcome {
  if (r.status === 400) return no(`Jira did not accept that ${what}`);
  if (r.status === 403) return no(`Your Jira account cannot do that on ${who}`);
  if (r.status === 404) return no("That is gone or not one this site shows you: reload the card");
  return { ok: false, unauthorised: r.unauthorised, error: r.error ?? `Jira did not accept that ${what}` };
}

/** The card as it now stands, after a write; a read that fails says so and keeps the write's news. */
export async function readBack(creds: JiraCreds, key: string, said: string): Promise<RelateOutcome> {
  const back = await readDetail(creds, key, { fresh: true, threads: false });
  if (!back.ok || !back.data) return { ok: true, partial: `${said}, but the card could not be read back. Reload it.` };
  return { ok: true, task: back.data.detail.task, detail: back.data.detail, more: back.data.more };
}

const guard = (key: string): RelateOutcome | null =>
  !jiraWriteEnabled() ? no(WRITE_OFF) : !ISSUE_KEY.test(key) ? no("That is not a Jira card id") : null;

/** One request: the links the card holds, as the site spells them. */
async function linksOf(creds: JiraCreds, upper: string): Promise<{ links: Record<string, unknown>[] } | { stop: RelateOutcome }> {
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}?fields=issuelinks`, { fresh: true });
  if (!r.ok) return { stop: { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not read the card's links first. ${r.error ?? "Jira did not answer"}` } };
  const f = isObj(r.data) && isObj(r.data.fields) ? r.data.fields : {};
  return { links: (Array.isArray(f.issuelinks) ? f.issuelinks : []).filter(isObj) };
}

// --- sub-tasks --------------------------------------------------------------

/** Make a sub-task under a card. */
export async function createSubtask(creds: JiraCreds, key: string, title: unknown): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) return no("A sub-task needs a title");
  if (/[\r\n]/.test(t)) return no("A title is one line");
  if (t.length > MAX_TITLE) return no(`A title is at most ${MAX_TITLE} characters`);
  const upper = key.toUpperCase();
  const project = projectOf(upper);
  const type = await subtaskType(creds, project);
  if (!type.ok || !type.data) return { ok: false, unauthorised: type.unauthorised, error: `Nothing was changed: could not tell which type a sub-task is. ${type.error ?? "Jira did not answer"}` };
  const post = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue`, {
    method: "POST",
    body: { fields: { project: { key: project }, parent: { key: upper }, summary: t, issuetype: { id: type.data } } },
  });
  if (!post.ok) {
    if (post.status === 400) return no("Jira did not accept that sub-task: this card may not take one (a sub-task cannot have its own)");
    // No answer or a server error says nothing about whether it was made, and sending it again would make a second.
    if (!post.throttled && !post.unauthorised && (post.status === undefined || post.status >= 500)) {
      return no(`${post.error ?? "Jira did not answer"}. The sub-task may have been made: reload the card before adding it again`);
    }
    return refusal(post, "sub-task", upper);
  }
  const made = isObj(post.data) ? str(post.data.key) : "";
  const back = await readBack(creds, upper, "The sub-task was made");
  return ISSUE_KEY.test(made) ? { ...back, created: made } : back;
}

// --- links to other cards ---------------------------------------------------

export interface RelateAsk { other: unknown; typeId: unknown; /** `true`: this card holds the outward phrase ("blocks"). */ outward: unknown }

/** Link a card to another, once. */
export async function relateCards(creds: JiraCreds, key: string, ask: RelateAsk): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  const other = typeof ask.other === "string" ? ask.other.trim().toUpperCase() : "";
  if (!ISSUE_KEY.test(other)) return no("The other card is a card id, like ORBIT-1042");
  const upper = key.toUpperCase();
  if (other === upper) return no("A card cannot be linked to itself");
  if (typeof ask.outward !== "boolean") return no("Say which way the link reads");
  const kinds = await linkKinds(creds);
  if (!kinds.ok || !kinds.data) return { ok: false, unauthorised: kinds.unauthorised, error: `Nothing was changed: could not read the site's link types. ${kinds.error ?? "Jira did not answer"}` };
  const kind = typeof ask.typeId === "string" ? kinds.data.find((k) => k.id === ask.typeId) : undefined;
  if (!kind) return no("That is not a link type this site has");
  const held = await linksOf(creds, upper);
  if ("stop" in held) return held.stop;
  // The card named on the far side of an entry is under `outwardIssue` when this card holds the outward phrase.
  const side = ask.outward ? "outwardIssue" : "inwardIssue";
  const there = held.links.some((l) => { const far = l[side]; return isObj(l.type) && idText(l.type.id) === kind.id && isObj(far) && str(far.key).toUpperCase() === other; });
  if (there) return { ok: true, already: true };
  const post = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issueLink`, {
    method: "POST",
    body: { type: { id: kind.id }, inwardIssue: { key: ask.outward ? upper : other }, outwardIssue: { key: ask.outward ? other : upper } },
  });
  if (!post.ok) return refusal(post, "link", upper);
  return readBack(creds, upper, "The link was made");
}

/** Take one of the card's links off, by the id the card itself holds. */
export async function unrelateCards(creds: JiraCreds, key: string, linkId: unknown): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  if (typeof linkId !== "string" || !ID.test(linkId)) return no("That is not a link this card has");
  const upper = key.toUpperCase();
  const held = await linksOf(creds, upper);
  if ("stop" in held) return held.stop;
  if (!held.links.some((l) => idText(l.id) === linkId)) return no("That is not a link this card has");
  const del = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issueLink/${linkId}`, { method: "DELETE" });
  if (!del.ok) return refusal(del, "change", upper);
  return readBack(creds, upper, "The link was taken off");
}

// --- web addresses ----------------------------------------------------------

const remotePath = (creds: JiraCreds, upper: string) => `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/remotelink`;

/** An address a person may follow: `http` or `https`, no password in it. The one form it is stored in. */
export function webAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || hasUrlCredentials(u) || !u.hostname) return null;
  return u.href;
}

async function remotesOf(creds: JiraCreds, upper: string): Promise<{ raw: unknown[] } | { stop: RelateOutcome }> {
  const r = await jiraCall<unknown>(creds, remotePath(creds, upper), { fresh: true });
  if (!r.ok) return { stop: { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not read the card's addresses first. ${r.error ?? "Jira did not answer"}` } };
  return { raw: Array.isArray(r.data) ? r.data : [] };
}

/** One address with or without the slash that ends a bare host: a card may hold the form another tool stored. */
const sameAddress = (a: string, b: string): boolean => a === b || a.replace(/\/$/, "") === b.replace(/\/$/, "");

/** Put a web address on a card, once. */
export async function addWebLink(creds: JiraCreds, key: string, address: unknown, title: unknown): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  const url = webAddress(address);
  if (!url) return no("A web address starts with http:// or https://");
  const upper = key.toUpperCase();
  const held = await remotesOf(creds, upper);
  if ("stop" in held) return held.stop;
  if (webLinksOf(held.raw).some((l) => sameAddress(l.url, url))) return { ok: true, already: true, web: webLinksOf(held.raw) };
  // eslint-disable-next-line no-control-regex
  const said = (typeof title === "string" ? title : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) || new URL(url).host;
  const post = await jiraCall<unknown>(creds, remotePath(creds, upper), { method: "POST", body: { globalId: url, object: { url, title: said } } });
  if (!post.ok) return refusal(post, "address", upper);
  const id = isObj(post.data) ? idText(post.data.id) : "";
  // The row is built from what was sent and the id Jira gave: one request less than reading the list again.
  return { ok: true, web: webLinksOf([...held.raw, { id: id || url, object: { url, title: said } }]) };
}

/** Take one of the card's web addresses off, by the id the card itself holds. */
export async function removeWebLink(creds: JiraCreds, key: string, linkId: unknown): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  if (typeof linkId !== "string" || !ID.test(linkId)) return no("That is not an address this card has");
  const upper = key.toUpperCase();
  const held = await remotesOf(creds, upper);
  if ("stop" in held) return held.stop;
  if (!held.raw.some((l) => isObj(l) && idText(l.id) === linkId)) return no("That is not an address this card has");
  const del = await jiraCall<unknown>(creds, `${remotePath(creds, upper)}/${linkId}`, { method: "DELETE" });
  if (!del.ok) return refusal(del, "change", upper);
  return { ok: true, web: webLinksOf(held.raw.filter((l) => !(isObj(l) && idText(l.id) === linkId))) };
}

// What the routes call: the stored connection, or the sentence that says there is none.
const stored = <A extends unknown[]>(run: (c: JiraCreds, ...a: A) => Promise<RelateOutcome>) =>
  (...a: A): Promise<RelateOutcome> => { const c = storedCreds(); return c ? run(c, ...a) : Promise.resolve({ ok: false, error: NOT_CONNECTED }); };
export const createSubtaskStored = stored(createSubtask);
export const relateCardsStored = stored(relateCards);
export const unrelateCardsStored = stored(unrelateCards);
export const addWebLinkStored = stored(addWebLink);
export const removeWebLinkStored = stored(removeWebLink);
