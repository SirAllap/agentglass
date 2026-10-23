/*
 * Boards, saved filters and searches, read as views.
 *
 * A Jira "view" is a board, a saved filter or a raw search. All three are read
 * through `searchJql`, the one search path, so the guards on it (a query with no
 * restriction is refused, pages are capped, a failed page is the answer) hold
 * here without being repeated.
 *
 * A board is NOT read through its card list. `GET /rest/agile/1.0/board/{id}/issue`
 * is marked deprecated in the Cloud API and answers with the board's own
 * membership rules applied by the server, which is exactly what we would have
 * to trust blindly. A board is its filter, narrowed by its sub-query, and an
 * issue is on it when its status is mapped to a column. That is written down
 * as one query:
 *
 *     (<filter restriction>) AND status in (<every mapped status id>)
 *       [AND (<sub-query>)] [ORDER BY <the filter's order>]
 *
 * Built from the board's configuration and its filter, both remembered ten
 * minutes: they change when a person edits the board, not by the minute. The
 * `status in` clause also keeps every board query bounded, so a board whose
 * filter is only an ordering still reads.
 *
 * A card is put in the column that holds its status ID, never its status name:
 * two statuses may share a name, and a column may hold several.
 *
 * Request cost, counted by tests against the stand-in: a board read cold is the
 * configuration, the filter and the search pages (plus the priority list once);
 * read again inside a minute it is nothing; forced, only the search pages.
 */
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";
import type {
  JiraColumn, JiraProjectChoice, ProviderTask, JiraViewChoice, JiraViewRead, JiraViews, ListStatus, SavedFolder, SavedView,
} from "../../shared/providers.ts";
import { redacted } from "./credentials.ts";
import {
  CATEGORY_COLOR, apiOf, jiraCall, jiraGeneration, orderByAt, memoOk, memoHas, mine, projects, searchJql, withStored,
  type JiraCreds, type JiraResult, type JiraTasks, type SeenStatus,
} from "./jira.ts";
import { activeSprint, boardEpics, quickFilterRows } from "./jiraBoardContext.ts";
import { underClause } from "../../shared/jiraAreas.ts";
import {
  addFolder, addView, cachedFor, currentView, isFolderBoard, putCache, removeFolder, removeView, replaceFolder, savedFolders, savedViews, setCurrent,
} from "./jiraviews.ts";

const AGILE = "/rest/agile/1.0";
const BOARD_PAGE = 50;
const FOLDER_PAGES = 2;
const FOLDER_TTL_MS = 10 * 60_000;
const VIEW_TTL_MS = 60_000;
const MAX_URL = 2000;
const MAX_JQL = 2000;
const NOT_CONNECTED = "Jira is not connected";

/** Ids that go into a query or a path are digits and nothing else. */
const NUM = /^\d{1,12}$/;
const KEY = /^[A-Z][A-Z0-9_]*$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const connectedSite = (): string | null => redacted("jira")?.site || null;

// ---------------------------------------------------------------------------
// pasted addresses
// ---------------------------------------------------------------------------

export type ParsedView =
  | { ok: true; kind: "board" | "filter" | "jql"; id: string; url: string; jql?: string }
  | { ok: false; error: string };

const NOT_A_VIEW = "That address is not a Jira board, a saved filter or a search. Paste a board's address, or one that ends in ?filter=10000";

/** The order clause is split off with the same rule `boundedJql` judges a query by. */
export function splitOrder(jql: string): { restriction: string; order: string } {
  const at = orderByAt(jql);
  return at >= 0 ? { restriction: jql.slice(0, at).trim(), order: jql.slice(at).trim() } : { restriction: jql.trim(), order: "" };
}

/**
 * An address pasted from the browser, judged against the connected site before
 * anything is sent: the same host and the same context path (a site may live
 * at `jira.acme.example/jira`), https only. Another host is not Jira's to
 * answer for, and a request for it would carry the credential there.
 */
export function parseViewUrl(text: string, site: string): ParsedView {
  const raw = text.trim();
  if (!raw || raw.length > MAX_URL) return { ok: false, error: NOT_A_VIEW };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: NOT_A_VIEW }; }
  if (u.protocol !== "https:") return { ok: false, error: "Paste the https address from your Jira site" };
  const slash = site.indexOf("/");
  const host = (slash < 0 ? site : site.slice(0, slash)).toLowerCase();
  const ctx = slash < 0 ? "" : site.slice(slash).replace(/\/+$/, "");
  if (u.host.toLowerCase() !== host) return { ok: false, error: `That address is not on your Jira site (${site})` };
  const p = u.pathname;
  if (ctx && p.toLowerCase() !== ctx.toLowerCase() && !p.toLowerCase().startsWith(ctx.toLowerCase() + "/")) {
    return { ok: false, error: `That address is not on your Jira site (${site})` };
  }
  const rest = p.slice(ctx.length) || "/";
  const q = u.searchParams;
  // What is kept is the address without a name and password, a fragment or a port nobody typed.
  const kept = `${u.origin}${u.pathname}${u.search}`;

  let m = /^\/jira\/software\/(?:c\/)?projects\/[A-Za-z][A-Za-z0-9_]*\/boards\/(\d{1,12})(?:\/|$)/.exec(rest);
  if (m) return { ok: true, kind: "board", id: m[1], url: kept };
  if (/^\/secure\/RapidBoard\.jspa$/i.test(rest) && NUM.test(q.get("rapidView") ?? "")) return { ok: true, kind: "board", id: q.get("rapidView")!, url: kept };
  if (NUM.test(q.get("filter") ?? "")) return { ok: true, kind: "filter", id: q.get("filter")!, url: kept };
  if (/^\/secure\/IssueNavigator\.jspa$/i.test(rest) && NUM.test(q.get("requestId") ?? "")) return { ok: true, kind: "filter", id: q.get("requestId")!, url: kept };

  m = /^\/issues\/?$/.exec(rest);
  const jql = q.get("jql")?.trim();
  if (m && jql) {
    if (jql.length > MAX_JQL) return { ok: false, error: "That search is too long to keep" };
    if (!splitOrder(jql).restriction) return { ok: false, error: "That search has no restriction, so it would read every card. Add a project or an assignee to it" };
    const canonical = `https://${site}/issues/?jql=${encodeURIComponent(jql)}`;
    return { ok: true, kind: "jql", id: `jql:${Bun.hash(jql).toString(36)}`, url: canonical, jql };
  }
  return { ok: false, error: NOT_A_VIEW };
}

/** The search kept in a `jql:` view's address. */
function jqlOfView(v: SavedView): string | null {
  try { return new URL(v.url).searchParams.get("jql")?.trim() || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// boards and filters
// ---------------------------------------------------------------------------

export interface BoardConfig {
  name: string;
  type: string;
  filterId: string;
  subQuery?: string;
  projectKey?: string;
  /** The field a board counts its cards in, when it says. */
  estimationField?: string;
  columns: JiraColumn[];
}

const BOARD_GONE = "That board is gone, or it is not shared with you";
const FILTER_GONE = "That saved filter is not shared with you, or it is gone";

/** What a board is made of. The path is the same on Cloud and Data Center. */
export function boardConfig(creds: JiraCreds, id: string): Promise<JiraResult<BoardConfig>> {
  if (!NUM.test(id)) return Promise.resolve({ ok: false, error: BOARD_GONE });
  return memoOk<BoardConfig>(creds, `board:${id}`, async () => {
    const r = await jiraCall<unknown>(creds, `${AGILE}/board/${id}/configuration`);
    if (!r.ok) return { ...r, data: undefined, ...(r.status === 404 || r.status === 403 ? { error: BOARD_GONE } : null) };
    const d = isObj(r.data) ? r.data : {};
    const filterId = idText(isObj(d.filter) ? d.filter.id : "");
    if (!NUM.test(filterId)) return { ok: false, error: "Jira did not say which filter that board reads" };
    const cols = isObj(d.columnConfig) && Array.isArray(d.columnConfig.columns) ? d.columnConfig.columns : [];
    const columns: JiraColumn[] = cols.filter(isObj).map((c) => ({
      name: str(c.name),
      statusIds: (Array.isArray(c.statuses) ? c.statuses : []).map((s) => idText(isObj(s) ? s.id : "")).filter((s) => NUM.test(s)),
    }));
    const sub = isObj(d.subQuery) ? str(d.subQuery.query).trim() : "";
    const loc = isObj(d.location) ? d.location : {};
    const est = isObj(d.estimation) && isObj(d.estimation.field) ? str(d.estimation.field.fieldId) : "";
    return {
      ok: true,
      data: {
        name: str(d.name) || `Board ${id}`,
        type: str(d.type),
        filterId,
        // A sub-query is a restriction; an order in it is not ours to apply.
        ...(splitOrder(sub).restriction ? { subQuery: splitOrder(sub).restriction } : {}),
        ...(str(loc.key) || str(loc.projectKey) ? { projectKey: str(loc.key) || str(loc.projectKey) } : {}),
        ...(/^customfield_\d{1,9}$/.test(est) ? { estimationField: est } : {}),
        columns,
      },
    };
  }, true);
}

/** A saved filter's name and query. Both generations serve it under their own prefix. */
export function filterJql(creds: JiraCreds, id: string): Promise<JiraResult<{ name: string; jql: string }>> {
  if (!NUM.test(id)) return Promise.resolve({ ok: false, error: FILTER_GONE });
  return memoOk<{ name: string; jql: string }>(creds, `filter:${id}`, async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/filter/${id}`);
    if (!r.ok) return { ...r, data: undefined, ...(r.status === 404 || r.status === 403 ? { error: FILTER_GONE } : null) };
    const d = isObj(r.data) ? r.data : {};
    return { ok: true, data: { name: str(d.name) || `Filter ${id}`, jql: str(d.jql) } };
  });
}

interface ViewRows extends JiraTasks { columns: JiraColumn[]; statuses?: ListStatus[] }

// ---------------------------------------------------------------------------
// the statuses of a view
// ---------------------------------------------------------------------------

/** Jira's three status categories, in the order a workflow reads: to do, doing, done. */
const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
/** The portable part of a ListStatus: `open` is to do, `custom` is in progress. */
const CATEGORY_TYPE: Record<string, string> = { new: "open", indeterminate: "custom", done: "done" };

const asListStatus = (s: SeenStatus, orderindex: number): ListStatus => ({
  status: s.name,
  type: CATEGORY_TYPE[s.category] ?? "custom",
  orderindex,
  ...(CATEGORY_COLOR[s.color] ? { color: CATEGORY_COLOR[s.color] } : {}),
});

/**
 * A project's statuses with their categories, for the ones no card wears.
 * Asked only when a board names a status none of its cards has, and then once
 * per ten minutes. A project that cannot be read is no statuses, remembered as
 * such, so a site that refuses it is asked once and not on every read.
 */
function projectStatusRows(creds: JiraCreds, project: string): Promise<JiraResult<SeenStatus[]>> {
  return memoOk<SeenStatus[]>(creds, `statusrows:${project}`, async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/project/${encodeURIComponent(project)}/statuses`);
    if (!r.ok) return r.status === 403 || r.status === 404 ? { ok: true, data: [] } : { ...r, data: undefined };
    const rows = new Map<string, SeenStatus>();
    for (const type of Array.isArray(r.data) ? r.data : []) {
      for (const st of isObj(type) && Array.isArray(type.statuses) ? type.statuses : []) {
        const id = isObj(st) ? idText(st.id) : "";
        if (!id || !str(isObj(st) ? st.name : "")) continue;
        const cat = isObj(st) && isObj(st.statusCategory) ? st.statusCategory : {};
        rows.set(id, { id, name: str((st as Record<string, unknown>).name), category: str(cat.key), color: str(cat.colorName), projects: [project] });
      }
    }
    return { ok: true, data: [...rows.values()] };
  });
}

/**
 * A board's statuses: its columns' statuses in column order. Names and
 * categories come from the cards that wear them; a status no card wears is
 * looked up once in the board's project (or the projects of its cards), and
 * one that cannot be found is left out rather than invented.
 */
async function boardStatuses(creds: JiraCreds, cfg: BoardConfig, rows: JiraTasks): Promise<ListStatus[]> {
  const known = new Map((rows.seen ?? []).map((x) => [x.id, x]));
  const order = [...new Set(cfg.columns.flatMap((c) => c.statusIds))];
  if (order.some((id) => !known.has(id))) {
    const projects = cfg.projectKey ? [cfg.projectKey] : [...new Set(rows.tasks.map((t) => t.listId).filter((k): k is string => !!k))];
    for (const key of projects) {
      const r = await projectStatusRows(creds, key);
      for (const x of r.ok && r.data ? r.data : []) if (!known.has(x.id)) known.set(x.id, x);
      if (order.every((id) => known.has(id))) break;
    }
  }
  return order.flatMap((id) => known.get(id) ?? []).map((x, i) => asListStatus(x, i));
}

/**
 * The statuses a filter, a search or "assigned to me" shows: the ones its
 * cards wear, merged by name across projects, in the column order of each
 * project's first board where that board is already known (the project is
 * saved as a folder, so no list of boards is asked for), then category, then
 * name. Ceiling: a project that is not a saved folder has no column order, and
 * a card whose project has several boards follows the first.
 */
async function viewStatuses(creds: JiraCreds, rows: JiraTasks): Promise<ListStatus[]> {
  const seen = rows.seen ?? [];
  const position = new Map<string, number[]>();
  const folders = savedFolders(creds.site);
  // Projects with the most cards first. A project whose first board is not known yet costs one request, and a read pays for at most one
  // of them: the rest are found on the reads that follow (a known board, or a remembered failure, is free), so a view across many saved
  // projects never costs more than the field list and one board configuration on top of its search.
  const cards = new Map<string, number>();
  for (const x of seen) for (const p of x.projects) cards.set(p, (cards.get(p) ?? 0) + 1);
  let lookups = 1;
  for (const key of [...cards.keys()].sort((a, b) => cards.get(b)! - cards.get(a)! || a.localeCompare(b))) {
    const first = folders.find((f) => f.id === key)?.lists?.[0]?.id;
    if (!first) continue;
    if (!memoHas(creds, `board:${first}`)) { if (lookups <= 0) continue; lookups--; }
    const cfg = await boardConfig(creds, first);
    const ids = cfg?.ok && cfg.data ? [...new Set(cfg.data.columns.flatMap((c) => c.statusIds))] : [];
    ids.forEach((id, i) => position.set(`${key}|${id}`, [...(position.get(`${key}|${id}`) ?? []), i]));
  }
  const byName = new Map<string, { s: SeenStatus; at: number }>();
  for (const x of seen) {
    const at = Math.min(Infinity, ...x.projects.flatMap((p) => position.get(`${p}|${x.id}`) ?? []));
    const k = x.name.toLowerCase();
    const have = byName.get(k);
    if (!have || at < have.at) byName.set(k, { s: x, at });
  }
  return [...byName.values()]
    .sort((a, b) => a.at - b.at || (CATEGORY_RANK[a.s.category] ?? 1) - (CATEGORY_RANK[b.s.category] ?? 1) || a.s.name.localeCompare(b.s.name))
    .map((x, i) => asListStatus(x.s, i));
}

/** Most quick filters one read may AND in: a board does not define anywhere near this many, and each is a clause of the query. */
const MAX_QUICK = 8;

/**
 * The clauses of the quick filters asked for, from the board's OWN list. An id the board no longer has is refused with
 * a sentence rather than dropped: a read that quietly ignored it would show more cards than the person asked for.
 */
async function quickClauses(creds: JiraCreds, board: string, ids: readonly string[]): Promise<JiraResult<string[]>> {
  if (!ids.length) return { ok: true, data: [] };
  if (ids.length > MAX_QUICK) return { ok: false, error: "Too many quick filters at once" };
  const all = await quickFilterRows(creds, board);
  if (!all.ok || !all.data) return { ...all, data: undefined };
  const out: string[] = [];
  for (const id of ids) {
    const q = all.data.find((x) => x.id === id);
    // Only the restriction: an order inside a quick filter is not ours to apply.
    const jql = q ? splitOrder(q.jql).restriction : "";
    if (!jql) return { ok: false, error: "That quick filter is gone from the board: reload it" };
    out.push(`(${jql})`);
  }
  return { ok: true, data: out };
}

/**
 * A board with an active sprint is read as two searches, not one. The board's own query is the whole project ranked, and
 * a project with a long history ranks its done cards ahead of the sprint: measured on a project of 1120 cards where the
 * sprint held 98, the first 150 ranked cards were all done and not one of them was in the sprint. So the sprint is asked
 * for by its id first (its cards, done and open), and what comes after it is the open cards that are not in it, which is
 * the backlog a person opens a board to see.
 *
 * `sprint is EMPTY OR sprint != id` and not `NOT sprint = id`: on the site measured the second leaves out every card
 * that has no sprint, which is the backlog. Ceiling: the backlog is one page of the open cards not in the sprint, and a
 * board with more says so through `truncated`; its done history is not read here.
 */
export function sprintQueries(where: readonly string[], order: string, sprintId: string): { sprint: string; rest: string } {
  const tail = order ? ` ${order}` : "";
  return {
    sprint: [...where, `sprint = ${sprintId}`].join(" AND ") + tail,
    rest: [...where, `(sprint is EMPTY OR sprint != ${sprintId})`, "statusCategory != Done"].join(" AND ") + tail,
  };
}

const BACKLOG_PAGES = 1;

async function searchSprintAndRest(creds: JiraCreds, q: { sprint: string; rest: string }, ask: { board: { points?: string } }): Promise<JiraResult<JiraTasks>> {
  const inSprint = await searchJql(creds, q.sprint, ask);
  if (!inSprint.ok || !inSprint.data) return inSprint;
  const rest = await searchJql(creds, q.rest, { ...ask, pages: BACKLOG_PAGES });
  if (!rest.ok || !rest.data) return rest;
  const seen = new Map((inSprint.data.seen ?? []).map((x) => [x.id, x]));
  for (const x of rest.data.seen ?? []) if (!seen.has(x.id)) seen.set(x.id, x);
  const ids = new Set(inSprint.data.tasks.map((t) => t.id));
  return {
    ok: true,
    data: {
      tasks: [...inSprint.data.tasks, ...rest.data.tasks.filter((t) => !ids.has(t.id))],
      truncated: inSprint.data.truncated || rest.data.truncated,
      seen: [...seen.values()],
    },
  };
}

/** The board's own restriction, as clauses a search can AND together, and the order its filter asks for. */
async function boardWhere(creds: JiraCreds, id: string, quick: readonly string[]): Promise<JiraResult<{ where: string[]; order: string; cfg: BoardConfig; empty: boolean; columns: JiraColumn[] }>> {
  const cfg = await boardConfig(creds, id);
  if (!cfg.ok || !cfg.data) return { ...cfg, data: undefined };
  const f = await filterJql(creds, cfg.data.filterId);
  if (!f.ok || !f.data) return { ...f, data: undefined };
  const columns = cfg.data.columns;
  const ids = [...new Set(columns.flatMap((c) => c.statusIds))];
  const { restriction, order } = splitOrder(f.data.jql);
  const clauses = await quickClauses(creds, id, quick);
  if (!clauses.ok || !clauses.data) return { ...clauses, data: undefined };
  const where = [
    ...(restriction ? [`(${restriction})`] : []),
    ...(ids.length ? [`status in (${ids.join(", ")})`] : []),
    ...(cfg.data.subQuery ? [`(${cfg.data.subQuery})`] : []),
    ...clauses.data,
  ];
  // A board whose columns map no status shows its columns and no cards.
  return { ok: true, data: { where, order, cfg: cfg.data, empty: !ids.length, columns } };
}

export async function readBoard(creds: JiraCreds, id: string, quick: readonly string[] = []): Promise<JiraResult<ViewRows>> {
  const w = await boardWhere(creds, id, quick);
  if (!w.ok || !w.data) return { ...w, data: undefined };
  const { where, order, cfg, columns } = w.data;
  if (w.data.empty) return { ok: true, data: { tasks: [], truncated: false, columns, statuses: [] } };
  // Free where the board's header already asked: the sprint is remembered under the same key as its context.
  const sprint = await activeSprint(creds, id);
  const ask = { board: { points: cfg.estimationField } };
  const plan = sprint.ok && sprint.data ? sprintQueries(where, order, sprint.data.id) : null;
  const r = plan ? await searchSprintAndRest(creds, plan, ask) : await searchJql(creds, where.join(" AND ") + (order ? ` ${order}` : ""), ask);
  if (!r.ok || !r.data) return { ...r, data: undefined };
  const { seen: _seen, ...rows } = r.data;
  return { ok: true, data: { ...rows, columns, statuses: await boardStatuses(creds, cfg, r.data) } };
}

/**
 * The cards that sit under an epic on a board, done and open, in ONE kept read. The Areas tree draws its counts from it
 * and an Area's page is filtered from it, so opening a board costs this one search (a few pages) per ten minutes and
 * nothing per area. The epics read are the areas plus at most OPEN_EPICS_MAX open ones beside them; an open epic past
 * that is not on the rail. Sub-tasks are left out (their parent is a story, not an area). Ceiling: AREA_PAGES pages of 50
 * cards, newest first; a project with more says so through `truncated` and the counts are then "at least".
 */
const AREA_PAGES = 6;
export function readBoardAreas(creds: JiraCreds, id: string): Promise<JiraResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  if (!NUM.test(id)) return Promise.resolve({ ok: false, error: BOARD_GONE });
  return memoOk<{ tasks: ProviderTask[]; truncated: boolean }>(creds, `areas:${id}`, async () => {
    const w = await boardWhere(creds, id, []);
    if (!w.ok || !w.data) return { ...w, data: undefined };
    if (w.data.empty) return { ok: true, data: { tasks: [], truncated: false } };
    // The epics named "Area: …" and the open ones beside them (see underClause): ask for their cards only, so a QA epic
    // holding a hundred runs does not use up the pages.
    const epics = await boardEpics(creds, id);
    const under = underClause(epics.data ?? []);
    const jql = [...w.data.where, under, "issuetype not in subTaskIssueTypes()"].join(" AND ") + " ORDER BY updated DESC";
    const r = await searchJql(creds, jql, { board: { points: w.data.cfg.estimationField }, pages: AREA_PAGES });
    if (!r.ok || !r.data) return { ...r, data: undefined };
    return { ok: true, data: { tasks: r.data.tasks, truncated: r.data.truncated } };
  });
}

async function plainView(creds: JiraCreds, jql: string): Promise<JiraResult<ViewRows>> {
  const r = await searchJql(creds, jql, { board: {} });
  if (!r.ok || !r.data) return { ...r, data: undefined };
  const { seen: _seen, ...rows } = r.data;
  return { ok: true, data: { ...rows, columns: [], statuses: await viewStatuses(creds, r.data) } };
}

export async function readFilter(creds: JiraCreds, id: string): Promise<JiraResult<ViewRows>> {
  const f = await filterJql(creds, id);
  if (!f.ok || !f.data) return { ...f, data: undefined };
  if (!splitOrder(f.data.jql).restriction) {
    return { ok: false, error: "That filter has no restriction, so it would read every card. Add a project or an assignee to it in Jira" };
  }
  return plainView(creds, f.data.jql);
}

export const readJql = (creds: JiraCreds, jql: string): Promise<JiraResult<ViewRows>> => plainView(creds, jql);

// ---------------------------------------------------------------------------
// reading a saved view
// ---------------------------------------------------------------------------

/**
 * The panel asks on every visit and every return to the window, so an answer
 * stands for a minute and a second ask while one is in the air joins it: at
 * most one read per view per minute however many windows look. `force` (the
 * Refresh button) skips both. Only a success is kept. An entry from before a
 * disconnect or a new connection (a different `gen`) is not an answer.
 */
const held = new Map<string, { gen: number; at: number; r?: JiraViewRead; run?: Promise<JiraViewRead> }>();

/** A narrowed read is its own entry; the oldest of them go first so a person trying every combination cannot fill memory. */
const MAX_NARROWED = 12;
function trimNarrowed(): void {
  const keys = [...held.keys()].filter((k) => k.includes("|q:"));
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_NARROWED))) held.delete(k);
}

/** A write that changes what a read would say (a rank) drops the minute every board read is held for. */
export const forgetViewReads = (): void => { held.clear(); };

const emptyRead = (error: string, view?: SavedView): JiraViewRead => ({ ok: false, error, ...(view ? { view } : null), tasks: [], columns: [], at: 0 });

async function readView(creds: JiraCreds, view: SavedView, force: boolean, quick: readonly string[] = []): Promise<JiraResult<ViewRows>> {
  if (view.id === ASSIGNED_VIEW_ID) {
    const r = await mine(creds, { fresh: force, board: true });
    if (!r.ok || !r.data) return { ...r, data: undefined };
    const { seen: _seen, ...rows } = r.data;
    return { ok: true, data: { ...rows, columns: [], statuses: await viewStatuses(creds, r.data) } };
  }
  const [kind, num] = view.id.split(":");
  if (kind === "board") return readBoard(creds, num, quick);
  if (kind === "filter") return readFilter(creds, num);
  const jql = kind === "jql" ? jqlOfView(view) : null;
  return jql ? readJql(creds, jql) : { ok: false, error: "That view has no search to run" };
}

let readFault: (() => void) | null = null;
/** Test seam: something that throws where a read begins, which no stand-in request can do. */
export const __setReadFault = (f: (() => void) | null): void => { readFault = f; };

function startRead(creds: JiraCreds, site: string, view: SavedView, force: boolean, quick: readonly string[] = []): Promise<JiraViewRead> {
  const gen = jiraGeneration();
  return Promise.resolve().then(() => { readFault?.(); return readView(creds, view, force, quick); }).then((r): JiraViewRead => {
    if (r.ok && r.data) {
      const at = Date.now();
      const out: JiraViewRead = { ok: true, view, tasks: r.data.tasks, columns: r.data.columns, ...(r.data.statuses ? { statuses: r.data.statuses } : null), at, ...(r.data.truncated ? { truncated: true } : null) };
      // A disconnect while this was in the air: the rows are not written back.
      // A narrowed read is a question of the moment: kept on disk it would be the board the next time it opens.
      if (gen === jiraGeneration() && !quick.length) putCache(site, view.id, { view, tasks: out.tasks, columns: out.columns, ...(out.statuses ? { statuses: out.statuses } : null), at, ...(out.truncated ? { truncated: true } : null) });
      return out;
    }
    // A failed read is never an empty board: the last good rows come back, said to be old.
    // Not for a narrowed one: the last rows kept are the whole board, and shown under a filter they would be wrong.
    const last = quick.length ? undefined : cachedFor(site, view.id);
    const error = r.error ?? "Could not read that view";
    return {
      ok: false, error, view, ...(r.throttled ? { throttled: true } : null), ...(r.unauthorised ? { unauthorised: true } : null),
      tasks: last?.tasks ?? [], columns: last?.columns ?? [], ...(last?.statuses ? { statuses: last.statuses } : null), at: last?.at ?? 0,
      ...(last?.truncated ? { truncated: true } : null), ...(last ? { cached: true } : null),
    };
  });
}

/**
 * One saved view: the current one when no id is given, else the built-in one.
 * `cached` answers from disk and asks nobody.
 */
export async function viewRead(id?: string, o: { force?: boolean; cached?: boolean; quick?: readonly string[] } = {}): Promise<JiraViewRead> {
  const site = connectedSite();
  if (!site) return emptyRead(NOT_CONNECTED);
  const views = savedViews(site);
  const want = id || currentView(site) || ASSIGNED_VIEW_ID;
  const view = views.find((v) => v.id === want);
  if (!view) return emptyRead("That view is not saved any more");
  if (want !== currentView(site)) setCurrent(site, want);

  // Quick filters narrow a board and nothing else; each distinct set is its own minute.
  const quick = want.startsWith("board:") ? [...new Set(o.quick ?? [])].sort() : [];
  if (o.cached && !quick.length) {
    const last = cachedFor(site, want);
    return last
      ? { ok: true, view, tasks: last.tasks, columns: last.columns, ...(last.statuses ? { statuses: last.statuses } : null), at: last.at, ...(last.truncated ? { truncated: true } : null), cached: true }
      : { ok: true, view, tasks: [], columns: [], at: 0, cached: true };
  }

  const k = `${site}|${want}${quick.length ? `|q:${quick.join(",")}` : ""}`;
  const hit = held.get(k);
  const gen = jiraGeneration();
  if (!o.force && hit && hit.gen === gen) {
    if (hit.run) return hit.run;
    if (hit.r && Date.now() - hit.at < VIEW_TTL_MS) return hit.r;
  }
  const settled = await withStored(async (creds): Promise<JiraResult<JiraViewRead>> => {
    const run: Promise<JiraViewRead> = startRead(creds, site, view, !!o.force, quick).catch((): JiraViewRead => emptyRead("Could not read that view", view)).then((r) => {
      const now = held.get(k);
      // A newer ask took the slot while this was in the air: leave it its own.
      if (now && now.run !== run) return r;
      if (r.ok && gen === jiraGeneration()) held.set(k, { gen, at: Date.now(), r }); else if (now?.run === run) held.delete(k);
      return r;
    });
    held.set(k, { gen, at: hit?.gen === gen ? hit.at : 0, r: hit?.gen === gen ? hit.r : undefined, run });
    if (quick.length) trimNarrowed();
    return { ok: true, data: await run };
  });
  if (settled.ok && settled.data) return settled.data;
  return { ...emptyRead(settled.error ?? NOT_CONNECTED, view), ...(settled.unauthorised ? { unauthorised: true } : null) };
}

// ---------------------------------------------------------------------------
// the add-a-view list
// ---------------------------------------------------------------------------

export interface ViewChoices { boards: JiraViewChoice[]; filters: JiraViewChoice[]; truncated: boolean; error?: string }

const boardsPage = (creds: JiraCreds, q: string) => memoOk<{ boards: JiraViewChoice[]; truncated: boolean }>(creds, `boards:${q}`, async () => {
  const r = await jiraCall<unknown>(creds, `${AGILE}/board?startAt=0&maxResults=${BOARD_PAGE}${q ? `&name=${encodeURIComponent(q)}` : ""}`);
  if (!r.ok) return { ...r, data: undefined };
  const d = isObj(r.data) ? r.data : {};
  const boards: JiraViewChoice[] = (Array.isArray(d.values) ? d.values : []).filter(isObj).flatMap((b) => {
    const id = idText(b.id);
    if (!NUM.test(id)) return [];
    const loc = isObj(b.location) ? b.location : {};
    return [{ kind: "board" as const, id, name: str(b.name) || `Board ${id}`, ...(str(b.type) ? { type: str(b.type) } : null), ...(str(loc.projectKey) ? { projectKey: str(loc.projectKey) } : null) }];
  });
  return { ok: true, data: { boards, truncated: d.isLast === false } };
});

const favouriteFilters = (creds: JiraCreds) => memoOk<JiraViewChoice[]>(creds, "filters:favourite", async () => {
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/filter/favourite`);
  if (!r.ok) return { ...r, data: undefined };
  const list = (Array.isArray(r.data) ? r.data : []).filter(isObj).flatMap((f) => {
    const id = idText(f.id);
    return NUM.test(id) ? [{ kind: "filter" as const, id, name: str(f.name) || `Filter ${id}` }] : [];
  });
  return { ok: true, data: list };
});

/** Boards (first page, by name) and favourite filters, each remembered ten minutes on its own, so one failing is not remembered. */
export async function viewChoices(creds: JiraCreds, query: string): Promise<JiraResult<ViewChoices>> {
  const q = query.trim().slice(0, 80);
  const [b, f] = await Promise.all([boardsPage(creds, q), favouriteFilters(creds)]);
  if (!b.ok && !f.ok) return { ...b, data: undefined };
  const needle = q.toLowerCase();
  const filters = f.ok && f.data ? f.data.filter((x) => !needle || x.name.toLowerCase().includes(needle)) : [];
  const error = !b.ok ? `Boards could not be listed: ${b.error}` : !f.ok ? `Saved filters could not be listed: ${f.error}` : undefined;
  return { ok: true, data: { boards: b.ok && b.data ? b.data.boards : [], filters, truncated: !!(b.ok && b.data?.truncated), ...(error ? { error } : null) } };
}

export async function projectChoices(creds: JiraCreds): Promise<JiraResult<{ projects: JiraProjectChoice[]; truncated: boolean }>> {
  const p = await projects(creds);
  if (!p.ok || !p.data) return { ...p, data: undefined };
  return { ok: true, data: { projects: p.data.keys.map((key) => ({ key, name: p.data!.names?.[key] ?? key })), truncated: p.data.truncated } };
}

// ---------------------------------------------------------------------------
// adding and removing
// ---------------------------------------------------------------------------

export type AddResult = { ok: true; view: SavedView } | { ok: false; error: string };

/** Names the view with one request, then keeps it. Nothing is kept when Jira will not name it. */
async function addResolved(creds: JiraCreds, kind: "board" | "filter" | "jql", id: string, url: string, jql?: string): Promise<AddResult> {
  let name: string;
  let viewId: string;
  if (kind === "board") {
    const c = await boardConfig(creds, id);
    if (!c.ok || !c.data) return { ok: false, error: c.error ?? BOARD_GONE };
    name = c.data.name; viewId = `board:${id}`;
  } else if (kind === "filter") {
    const f = await filterJql(creds, id);
    if (!f.ok || !f.data) return { ok: false, error: f.error ?? FILTER_GONE };
    name = f.data.name; viewId = `filter:${id}`;
  } else {
    name = `Search: ${(jql ?? "").slice(0, 40)}`; viewId = id;
  }
  const view: SavedView = { id: viewId, name, url, addedAt: Date.now() };
  addView(creds.site, view);
  return { ok: true, view };
}

export function addViewByUrl(text: string): Promise<JiraResult<AddResult>> {
  return withStored(async (creds) => {
    const p = parseViewUrl(text, creds.site);
    if (!p.ok) return { ok: true, data: p };
    return { ok: true, data: await addResolved(creds, p.kind, p.id, p.url, p.jql) };
  });
}

export function addViewByChoice(kind: unknown, id: unknown): Promise<JiraResult<AddResult>> {
  return withStored(async (creds) => {
    if ((kind !== "board" && kind !== "filter") || typeof id !== "string" || !NUM.test(id)) {
      return { ok: true, data: { ok: false, error: "Pick a board or a saved filter from the list" } };
    }
    const url = kind === "board" ? `https://${creds.site}/secure/RapidBoard.jspa?rapidView=${id}` : `https://${creds.site}/issues/?filter=${id}`;
    return { ok: true, data: await addResolved(creds, kind, id, url) };
  });
}

/** A project's boards, as many pages as the cap allows. */
async function boardsOfProject(creds: JiraCreds, key: string): Promise<JiraResult<{ lists: { id: string; name: string }[]; projectName?: string }>> {
  const lists: { id: string; name: string }[] = [];
  let projectName: string | undefined;
  let start = 0;
  for (let page = 0; page < FOLDER_PAGES; page++) {
    const r = await jiraCall<unknown>(creds, `${AGILE}/board?projectKeyOrId=${encodeURIComponent(key)}&startAt=${start}&maxResults=${BOARD_PAGE}`);
    if (!r.ok) return { ...r, data: undefined, ...(r.status === 404 ? { error: "No such project, or you cannot see it" } : null) };
    const d = isObj(r.data) ? r.data : {};
    const values = (Array.isArray(d.values) ? d.values : []).filter(isObj);
    for (const b of values) {
      const id = idText(b.id);
      if (NUM.test(id)) lists.push({ id, name: str(b.name) || `Board ${id}` });
      if (!projectName && isObj(b.location)) projectName = str(b.location.projectName) || undefined;
    }
    start += values.length;
    if (d.isLast !== false || !values.length) break;
  }
  return { ok: true, data: { lists, projectName } };
}

async function folderFor(creds: JiraCreds, key: string, addedAt: number): Promise<JiraResult<SavedFolder>> {
  const [b, p] = await Promise.all([boardsOfProject(creds, key), projects(creds)]);
  if (!b.ok || !b.data) return { ...b, data: undefined };
  const name = (p.ok ? p.data?.names?.[key] : undefined) || b.data.projectName || key;
  return { ok: true, data: { id: key, name, spaceId: key, spaceName: name, addedAt, lists: b.data.lists, listsAt: Date.now() } };
}

export function addFolderByKey(raw: unknown): Promise<JiraResult<{ folder: SavedFolder }>> {
  return withStored(async (creds) => {
    const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!KEY.test(key) || key.length > 64) return { ok: false, error: "Pick a project from the list" };
    const f = await folderFor(creds, key, Date.now());
    if (!f.ok || !f.data) return { ...f, data: undefined };
    addFolder(creds.site, f.data);
    return { ok: true, data: { folder: f.data } };
  });
}

export function removeViewById(id: string): { ok: boolean; error?: string } {
  const site = connectedSite();
  if (!site) return { ok: true };
  // A project's board is not a stored view: filtering the store would say yes and drop its rows for nothing.
  if (isFolderBoard(site, id)) return { ok: false, error: "That board comes with its project; remove the project instead" };
  removeView(site, id);
  return { ok: true };
}

export function removeFolderById(id: string): void {
  const site = connectedSite();
  if (site) removeFolder(site, id);
}

let foldersRunning = false;
/** Failed refreshes wait out the same ten minutes, so a project that errors is not asked on every look at the rail. */
const folderTried = new Map<string, number>();
/** Test seam: forget which folders were tried. */
export const __resetFolderTried = (): void => { folderTried.clear(); };

/** Re-read the boards of folders older than ten minutes. Called in the background when the rail is asked for; never throws. */
export async function refreshJiraFoldersIfStale(): Promise<void> {
  const site = connectedSite();
  if (!site || foldersRunning) return;
  const now = Date.now();
  const stale = savedFolders(site).filter((f) => (!f.listsAt || now - f.listsAt > FOLDER_TTL_MS) && now - (folderTried.get(`${site}|${f.id}`) ?? 0) > FOLDER_TTL_MS);
  if (!stale.length) return;
  foldersRunning = true;
  const gen = jiraGeneration();
  try {
    await withStored(async (creds) => {
      for (const f of stale) {
        folderTried.set(`${site}|${f.id}`, Date.now());
        // A disconnect (or another account) while the loop runs ends it.
        if (gen !== jiraGeneration()) break;
        const r = await folderFor(creds, f.id, f.addedAt);
        if (gen !== jiraGeneration()) break;
        // In place, so the rail does not reorder; a folder removed while this was in the air stays removed.
        if (r.ok && r.data) replaceFolder(site, r.data);
      }
      return { ok: true, data: null };
    });
  } catch { /* the rail keeps what it had */ } finally { foldersRunning = false; }
}

/** `GET /jira/views`: the local store only. */
export function jiraViews(): JiraViews {
  const site = connectedSite();
  if (!site) return { connected: false, site: null, views: [], folders: [] };
  const views = savedViews(site);
  const cur = currentView(site);
  return { connected: true, site, views, folders: savedFolders(site), ...(cur && views.some((v) => v.id === cur) ? { current: cur } : null) };
}
