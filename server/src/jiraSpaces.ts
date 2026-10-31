/*
 * Jira spaces, server side: the projects the person added to the sidebar and
 * the live tree of components and epics each one draws. Reads only; the list of
 * spaces is the local settings file's, like the counted projects.
 *
 * The contract is shared/jiraSpaces.ts.
 *
 * Request budget, measured at the stand-in (test/jira-spaces.test.ts): a tree
 * read cold is the components (1) + the epic pages + the card pages, whatever
 * the number of components or epics; read again inside the hold it is nothing.
 * The counts per component come out of the card pages, never a request per
 * component. Limits chosen: Cloud's epic link is the card's `parent`; Data
 * Center keeps it in a custom field, so there every card reads as "No epic".
 * A project past MAX_CARDS cards is refused with a sentence, not drawn short.
 */
import { SPACE_KEY_MAX, type JiraEpicCard, type JiraEpicCardsOut, type JiraPickerProject, type JiraSpace, type JiraSpacesOut, type JiraSpaceTree, type JiraSpaceTreeOut, type JiraTreeComponent, type JiraTreeEpic } from "../../shared/jiraSpaces.ts";
import { ISSUE_KEY, NOT_CONNECTED, apiOf, idText, isObj, jiraCall, jiraGeneration, memoHas, memoOk, projectKey, projectStatuses, readSettingsFile, searchJql, storedCreds, str, toPerson, withStored, writeSettingsKey, type JiraCreds, type JiraResult } from "./jira.ts";
import type { JiraPerson, ProviderTask } from "../../shared/providers.ts";

const MAX_SPACES = 200;
const NO_SUCH_PROJECT = "No Jira project with that key";
const BAD_KEY = "That is not a Jira project key";

// ---------------------------------------------------------------------------
// the list the person keeps
// ---------------------------------------------------------------------------

const shownAvatar = (v: unknown): string | undefined => (typeof v === "string" && v.startsWith("https://") ? v : undefined);
const goodKey = (v: unknown): v is string => projectKey(v) && v.length <= SPACE_KEY_MAX;

/** The settings file's `spaces`, in the order added; anything that is not a space is dropped, never trusted. */
function storedSpaces(): JiraSpace[] {
  const raw = readSettingsFile().spaces;
  const seen = new Set<string>();
  const out: JiraSpace[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!isObj(v) || !goodKey(v.key) || seen.has(v.key)) continue;
    seen.add(v.key);
    const avatarUrl = shownAvatar(v.avatarUrl);
    out.push({ key: v.key, name: str(v.name) || v.key, ...(avatarUrl ? { avatarUrl } : {}) });
  }
  return out.slice(0, MAX_SPACES);
}

export function spacesList(): JiraSpacesOut {
  const c = storedCreds();
  return { ok: true, spaces: storedSpaces().map((s) => { const n = c ? heldCount(c, s.key) : undefined; return n === undefined ? s : { ...s, count: n }; }) };
}

interface Listed { key: string; name: string; avatarUrl?: string }

function toListed(v: unknown): Listed | null {
  if (!isObj(v) || !projectKey(v.key)) return null;
  const avatarUrl = shownAvatar(isObj(v.avatarUrls) ? v.avatarUrls["48x48"] : undefined);
  return { key: v.key, name: str(v.name) || v.key, ...(avatarUrl ? { avatarUrl } : {}) };
}

/** One project by key: the typed key of the picker, and an add when the list is not remembered. */
async function resolveProject(c: JiraCreds, key: string): Promise<JiraResult<Listed>> {
  const r = await jiraCall<unknown>(c, `/rest/api/${apiOf(c)}/project/${encodeURIComponent(key)}`);
  if (!r.ok) return { ...r, data: undefined, ...(r.status === 404 ? { error: NO_SUCH_PROJECT } : {}) };
  const p = toListed(r.data);
  return p ? { ok: true, data: p } : { ok: false, error: NO_SUCH_PROJECT };
}

export async function spacesEdit(body: unknown): Promise<JiraSpacesOut | { ok: false; error: string }> {
  const b = isObj(body) ? body : null;
  const verbs = b ? Object.keys(b) : [];
  if (!b || verbs.length !== 1 || !["add", "remove", "order"].includes(verbs[0]!)) return { ok: false, error: "Say one of add, remove or order" };
  const have = storedSpaces();
  const done = (spaces: Listed[]): JiraSpacesOut => { writeSettingsKey("spaces", spaces); return spacesList(); };

  if (verbs[0] === "remove") {
    if (!goodKey(b.remove)) return { ok: false, error: BAD_KEY };
    return have.some((s) => s.key === b.remove) ? done(have.filter((s) => s.key !== b.remove)) : spacesList();
  }
  if (verbs[0] === "order") {
    const want = b.order;
    // A permutation of what is there: an order that adds or drops a space is a different edit.
    if (!Array.isArray(want) || want.length !== have.length || new Set(want).size !== want.length || !want.every((k) => have.some((s) => s.key === k))) {
      return { ok: false, error: "The order must list every space once" };
    }
    return done(want.map((k) => have.find((s) => s.key === k)!));
  }
  if (!goodKey(b.add)) return { ok: false, error: BAD_KEY };
  const key = b.add;
  if (have.some((s) => s.key === key)) return spacesList();
  if (have.length >= MAX_SPACES) return { ok: false, error: `${MAX_SPACES} spaces at most` };
  const c = storedCreds();
  if (!c) return { ok: false, error: NOT_CONNECTED };
  // The picker's list when it is remembered (no request); the one project when it is not.
  let found: Listed | undefined;
  if (memoHas(c, PICKER_MEMO)) found = (await projectList(c)).data?.find((p) => p.key === key);
  if (!found) {
    const r = await resolveProject(c, key);
    if (!r.ok || !r.data) return { ok: false, error: r.error ?? NO_SUCH_PROJECT };
    found = r.data;
  }
  return done([...have, found]);
}

// ---------------------------------------------------------------------------
// the picker
// ---------------------------------------------------------------------------

const PICKER_MEMO = "spaces-picker";
const PICKER_PAGE = 50;
/** The most project pages read: 1000 projects. A project past it is still found by typing its key. */
const PICKER_PAGES = 20;

/** Every project the account sees, paged on Cloud and one array on Data Center, remembered ten minutes. */
function projectList(c: JiraCreds): Promise<JiraResult<Listed[]>> {
  return memoOk<Listed[]>(c, PICKER_MEMO, async () => {
    if (apiOf(c) === 2) {
      const r = await jiraCall<unknown>(c, "/rest/api/2/project");
      if (!r.ok) return { ...r, data: undefined };
      return { ok: true, data: (Array.isArray(r.data) ? r.data : []).map(toListed).filter((p): p is Listed => !!p) };
    }
    const out: Listed[] = [];
    let start = 0;
    for (let page = 0; page < PICKER_PAGES; page++) {
      const r = await jiraCall<{ values?: unknown[]; isLast?: boolean }>(c, `/rest/api/3/project/search?startAt=${start}&maxResults=${PICKER_PAGE}`);
      if (!r.ok) return { ...r, data: undefined };
      const values = Array.isArray(r.data?.values) ? r.data!.values! : [];
      for (const v of values) { const p = toListed(v); if (p) out.push(p); }
      // The next page starts where this one ended: Jira may cap a page below what was asked.
      start += values.length;
      if (r.data?.isLast !== false || !values.length) break;
    }
    return { ok: true, data: out };
  });
}

export function jiraSpacePickerStored(q: string): Promise<JiraResult<JiraPickerProject[]>> {
  return withStored(async (c) => {
    const list = await projectList(c);
    if (!list.ok || !list.data) return { ...list, data: undefined };
    let rows = list.data;
    const typed = q.trim();
    // Typing narrows nothing here (the panel filters); it only reaches a project the list did not hold.
    if (typed && !rows.some((p) => p.key.includes(typed.toUpperCase()) || p.name.toLowerCase().includes(typed.toLowerCase()))) {
      const key = typed.toUpperCase();
      if (!goodKey(key)) return { ok: false, error: NO_SUCH_PROJECT };
      const one = await resolveProject(c, key);
      if (!one.ok || !one.data) return { ...one, data: undefined };
      rows = [one.data, ...rows];
    }
    const added = new Set(storedSpaces().map((s) => s.key));
    return { ok: true, data: rows.map((p) => ({ ...p, added: added.has(p.key) })) };
  });
}

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

/** How long a tree read is trusted. A `fresh` read, a disconnect and a new base skip it. */
const TREE_TTL_MS = 3 * 60_000;
const SEARCH_PAGE = 100;
/** 50 pages of 100: past it the project is refused rather than drawn short. */
const MAX_PAGES = 50;
const MAX_CARDS = SEARCH_PAGE * MAX_PAGES;

interface RawEpic { key: string; id: string; summary: string; status: JiraTreeEpic["status"]; components: string[]; assignee: JiraPerson | null; reporter: JiraPerson | null }
interface RawCard { parent: string; done: boolean; components: string[] }
interface Raw { at: number; components: { id: string; name: string }[]; epics: RawEpic[]; cards: RawCard[] }

const held = new Map<string, { gen: number; raw: Raw }>();
const flying = new Map<string, Promise<JiraResult<Raw>>>();
const heldKey = (c: JiraCreds, space: string): string => `${c.site}|${c.cloudId ?? ""}|${space}`;

function heldCount(c: JiraCreds, space: string): number | undefined {
  const h = held.get(heldKey(c, space));
  return h && h.gen === jiraGeneration() ? h.raw.cards.length : undefined;
}

/**
 * Every issue of a search, raw. `searchJql` maps issues to tasks, which have no
 * components, so the tree pages its own: the same two generations, one request a
 * page, and a page that fails is the answer.
 */
async function pageIssues(c: JiraCreds, jql: string, fields: string[], optional: boolean): Promise<JiraResult<unknown[]>> {
  const out: unknown[] = [];
  let token: string | undefined;
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (apiOf(c) === 2) {
      const r = await jiraCall<{ issues?: unknown[]; maxResults?: number }>(c, "/rest/api/2/search", { method: "POST", optional, body: { jql, fields, maxResults: SEARCH_PAGE, startAt: start } });
      if (!r.ok) return { ...r, data: undefined };
      const issues = Array.isArray(r.data?.issues) ? r.data!.issues! : [];
      out.push(...issues);
      start += issues.length;
      const asked = typeof r.data?.maxResults === "number" && r.data.maxResults > 0 ? Math.min(r.data.maxResults, SEARCH_PAGE) : SEARCH_PAGE;
      if (issues.length < asked) return { ok: true, data: out };
    } else {
      const r = await jiraCall<{ issues?: unknown[]; isLast?: boolean; nextPageToken?: string }>(c, "/rest/api/3/search/jql", { method: "POST", optional, body: { jql, fields, maxResults: SEARCH_PAGE, ...(token ? { nextPageToken: token } : {}) } });
      if (!r.ok) return { ...r, data: undefined };
      out.push(...(Array.isArray(r.data?.issues) ? r.data!.issues! : []));
      token = typeof r.data?.nextPageToken === "string" && r.data.nextPageToken ? r.data.nextPageToken : undefined;
      if (r.data?.isLast === true || !token) return { ok: true, data: out };
    }
  }
  return { ok: false, error: `${MAX_CARDS} cards at most can be drawn, and this project has more` };
}

const fieldsOf = (i: unknown): Record<string, unknown> => (isObj(i) && isObj(i.fields) ? i.fields : {});
const categoryOf = (f: Record<string, unknown>): string => (isObj(f.status) && isObj(f.status.statusCategory) ? str(f.status.statusCategory.key) : "");
const componentNames = (f: Record<string, unknown>): string[] => (Array.isArray(f.components) ? f.components.map((x) => (isObj(x) ? str(x.name) : "")).filter(Boolean) : []);

async function readRaw(c: JiraCreds, space: string, optional: boolean): Promise<JiraResult<Raw>> {
  const comps = await jiraCall<unknown>(c, `/rest/api/${apiOf(c)}/project/${space}/components`, { optional });
  if (!comps.ok) return { ...comps, data: undefined };
  const components = (Array.isArray(comps.data) ? comps.data : []).flatMap((x) => (isObj(x) && str(x.name) ? [{ id: idText(x.id), name: str(x.name) }] : []));

  const epicRows = await pageIssues(c, `project = ${space} AND issuetype = Epic ORDER BY key ASC`, ["summary", "status", "components", "assignee", "reporter"], optional);
  if (!epicRows.ok) return { ...epicRows, data: undefined };
  const epics = (epicRows.data ?? []).flatMap((i): RawEpic[] => {
    const f = fieldsOf(i);
    const key = isObj(i) ? str(i.key) : "";
    if (!key) return [];
    const cat = categoryOf(f);
    return [{ key, id: isObj(i) ? idText(i.id) || key : key, summary: str(f.summary), components: componentNames(f), assignee: toPerson(f.assignee, apiOf(c)), reporter: toPerson(f.reporter, apiOf(c)),
      status: { name: isObj(f.status) ? str(f.status.name) : "", category: cat === "done" ? "done" : cat === "new" || cat === "indeterminate" ? "open" : "other" } }];
  });

  // Sub-tasks are not cards of the tree: they hang from a card and the epic's list nests them.
  const cardRows = await pageIssues(c, `project = ${space} AND issuetype != Epic AND issuetype not in subTaskIssueTypes() ORDER BY key ASC`, ["parent", "status", "components", "issuetype"], optional);
  if (!cardRows.ok) return { ...cardRows, data: undefined };
  const cards = (cardRows.data ?? []).flatMap((i): RawCard[] => {
    const f = fieldsOf(i);
    if (isObj(f.issuetype) && f.issuetype.subtask === true) return [];
    return [{ parent: isObj(f.parent) ? str(f.parent.key) : "", done: categoryOf(f) === "done", components: componentNames(f) }];
  });
  return { ok: true, data: { at: Date.now(), components, epics, cards } };
}

/** The cached read, or one request chain; two readers of one space share the chain. */
function raw(c: JiraCreds, space: string, fresh: boolean): Promise<JiraResult<Raw>> {
  const k = heldKey(c, space);
  const gen = jiraGeneration();
  const hit = held.get(k);
  if (!fresh && hit && hit.gen === gen && Date.now() - hit.raw.at < TREE_TTL_MS) return Promise.resolve({ ok: true, data: hit.raw });
  const going = flying.get(k);
  if (going) return going;
  const p = readRaw(c, space, !fresh).then((r) => {
    // A disconnect while this was in the air: do not write it back.
    if (r.ok && r.data && gen === jiraGeneration()) held.set(k, { gen, raw: r.data });
    return r;
  }).finally(() => { if (flying.get(k) === p) flying.delete(k); });
  flying.set(k, p);
  return p;
}

const NONE = "\u0000none";

/** The tree from what was read. A pure function of it, so the Done toggle costs no request. */
function build(space: string, r: Raw, showDone: boolean): JiraSpaceTree {
  const epicOf = new Map(r.epics.map((e) => [e.key, e]));
  const progress = new Map<string, { done: number; total: number }>();
  const cardsIn = new Map<string, Set<string>>(); // epic key -> component names it has cards in
  type Group = { id?: string; name: string; issues: number; noEpic: number; epics: Set<string> };
  const groups = new Map<string, Group>(r.components.map((x) => [x.name, { id: x.id, name: x.name, issues: 0, noEpic: 0, epics: new Set() }]));
  const group = (name: string): Group => {
    let g = groups.get(name);
    if (!g) groups.set(name, g = { name: name === NONE ? "No component" : name, issues: 0, noEpic: 0, epics: new Set() });
    return g;
  };
  let noEpic = 0;
  let done = 0;
  for (const card of r.cards) {
    const epic = epicOf.get(card.parent);
    if (card.done) done++;
    if (epic) {
      const p = progress.get(epic.key) ?? { done: 0, total: 0 };
      p.total++;
      if (card.done) p.done++;
      progress.set(epic.key, p);
    } else noEpic++;
    for (const name of card.components.length ? card.components : [NONE]) {
      const g = group(name);
      g.issues++;
      if (!epic) { g.noEpic++; continue; }
      g.epics.add(epic.key);
      if (name === NONE) continue;
      const seen = cardsIn.get(epic.key) ?? new Set<string>();
      cardsIn.set(epic.key, seen.add(name));
    }
  }
  // An epic with no cards is still an epic: it stays under its own components, or under "No component".
  for (const e of r.epics) if (!progress.has(e.key)) for (const name of e.components.length ? e.components : [NONE]) group(name).epics.add(e.key);

  const hidDone = showDone ? 0 : r.epics.filter((e) => e.status.category === "done").length;
  const treeEpic = (e: RawEpic): JiraTreeEpic => ({ key: e.key, id: e.id, summary: e.summary, status: e.status, ...(progress.get(e.key) ?? { done: 0, total: 0 }), components: [...(cardsIn.get(e.key) ?? [])], assignee: e.assignee, reporter: e.reporter });
  const shown = (g: Group): JiraTreeComponent => ({
    ...(g.id ? { id: g.id } : {}), name: g.name, issues: g.issues, empty: g.issues === 0 && g.epics.size === 0,
    epics: r.epics.filter((e) => g.epics.has(e.key) && (showDone || e.status.category !== "done")).map(treeEpic), noEpic: g.noEpic,
  });
  const none = groups.get(NONE);
  const components = [...groups].filter(([k]) => k !== NONE).map(([, g]) => shown(g));
  if (none && (none.issues || none.epics.size)) components.push(shown(none));
  return { space, noEpic, components, total: r.cards.length, done, hidDone, readAt: r.at };
}

export async function jiraSpaceTreeStored(space: string, fresh: boolean, showDone: boolean): Promise<JiraSpaceTreeOut> {
  if (!goodKey(space)) return { ok: false, error: BAD_KEY };
  const c = storedCreds();
  if (!c) return { ok: false, error: NOT_CONNECTED };
  const r = await raw(c, space, fresh);
  if (r.ok && r.data) return { ok: true, ...build(space, r.data, showDone) };
  // The last good read, when there is one, is what the panel can still draw from.
  const last = held.get(heldKey(c, space));
  return { ok: false, error: r.error ?? "Could not reach Jira", ...(r.throttled ? { throttled: true } : {}), ...(last && last.gen === jiraGeneration() ? { staleAt: last.raw.at } : {}) };
}

// ---------------------------------------------------------------------------
// an epic's cards
// ---------------------------------------------------------------------------

/** The most cards of one epic listed: 20 pages. */
const EPIC_PAGES = 20;
const CHILD_CHUNK = 100;

/** Blocked is how the card says it: flagged, or a status whose name says so. No name of a team's own is assumed beyond that word. */
export const blockedCard = (t: Pick<ProviderTask, "status" | "flagged">): boolean => t.flagged === true || /block/i.test(t.status);

const keyNumber = (k: string): number => Number(k.slice(k.lastIndexOf("-") + 1)) || 0;
const byKey = (a: ProviderTask, b: ProviderTask): number => keyNumber(a.customId ?? "") - keyNumber(b.customId ?? "");

export async function jiraEpicCardsStored(epic: string): Promise<JiraEpicCardsOut> {
  const key = typeof epic === "string" ? epic.trim().toUpperCase() : "";
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const c = storedCreds();
  if (!c) return { ok: false, error: NOT_CONNECTED };
  const fail = (r: JiraResult<unknown>): JiraEpicCardsOut => ({ ok: false, error: r.error ?? "Could not reach Jira", ...(r.throttled ? { throttled: true } : {}) });

  const kids = await searchJql(c, `parent = ${key} ORDER BY key ASC`, { pages: EPIC_PAGES, board: {} });
  if (!kids.ok || !kids.data) return fail(kids);
  if (kids.data.truncated) return { ok: false, error: "This epic has more cards than can be listed here" };
  const cards = kids.data.tasks;

  // One more search for every sub-task of every card, and only for cards that say they have any.
  const subtasks = new Map<string, ProviderTask[]>();
  const parents = cards.filter((t) => t.subtasks && t.customId).map((t) => t.customId!);
  for (let i = 0; i < parents.length; i += CHILD_CHUNK) {
    const subs = await searchJql(c, `parent in (${parents.slice(i, i + CHILD_CHUNK).join(",")}) ORDER BY key ASC`, { pages: EPIC_PAGES, board: {} });
    if (!subs.ok || !subs.data) return fail(subs);
    for (const s of subs.data.tasks) if (s.parent) subtasks.set(s.parent.key, [...(subtasks.get(s.parent.key) ?? []), s]);
  }

  // The project's own status order; a project whose statuses cannot be read keeps the order by key.
  const order = await projectStatuses(c, key.slice(0, key.lastIndexOf("-")));
  const rank = (t: ProviderTask): number => {
    const at = (order.data ?? []).findIndex((s) => s.id === t.statusId || s.name === t.status);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const out: JiraEpicCard[] = cards.map((task) => ({ task, type: task.issueType ?? "", subtasks: (subtasks.get(task.customId ?? "") ?? []).sort(byKey), blocked: blockedCard(task) }));
  out.sort((a, b) => Number(b.blocked) - Number(a.blocked) || rank(a.task) - rank(b.task) || byKey(a.task, b.task));
  return { ok: true, epic: key, cards: out, readAt: Date.now() };
}
