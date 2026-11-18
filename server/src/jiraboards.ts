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
import { parseScope, scopeJql, scopeName } from "../../shared/jiraScope.ts";
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";
import type { JiraAddChoice } from "../../shared/jiraSpaces.ts";
import type {
  JiraColumn, JiraFavourite, JiraProjectChoice, ProviderTask, JiraViewChoice, JiraViewRead, JiraViews, ListStatus, SavedFolder, SavedView,
} from "../../shared/providers.ts";
import { jiraAccount, jiraNotes } from "./jiraAccount.ts";
const redacted = (_id: "jira") => jiraNotes();
import {
  CATEGORY_COLOR, apiOf, jiraCall, jiraGeneration, orderByAt, memoOk, memoHas, forgetMiss, mine, projectKey, projectStatuses, projects, searchJql, withStored,
  type JiraCreds, type JiraResult, type JiraTasks, type SeenStatus, type WorkflowStatus,
} from "./jira.ts";
import { activeSprint, boardEpics, quickFilterRows } from "./jiraBoardContext.ts";
import { spaceColumnBoard } from "./jiraSpaces.ts";
import { ASSIGNEE_ID, jqlForView } from "./jiraJql.ts";
import { underClause } from "../../shared/jiraAreas.ts";
import {
  addFolder, addView, cachedFor, currentView, isFolderBoard, patchView, putCache, removeFolder, removeView, replaceFolder, savedFolders, savedViews, setCurrent, upsertView,
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
  | { ok: true; kind: "board" | "filter" | "jql"; id: string; url: string; jql?: string; alternatives?: JiraAddChoice[] }
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

  // A project's own list or board view (no board id): its jql is the search, and without one the whole project.
  const view = /^\/jira\/(?:software|core|business)\/(?:c\/)?projects\/([^/]+)\/(?:list|board|issues)\/?$/.exec(rest);
  if (view && !projectKey(view[1])) return { ok: false, error: NOT_A_VIEW };

  m = /^\/issues\/?$/.exec(rest);
  const jql = q.get("jql")?.trim() || (view ? `project = ${view[1]}` : undefined);
  if ((m || view) && jql) {
    if (jql.length > MAX_JQL) return { ok: false, error: "That search is too long to keep" };
    if (!splitOrder(jql).restriction) return { ok: false, error: "That search has no restriction, so it would read every card. Add a project or an assignee to it" };
    const canonical = `https://${site}/issues/?jql=${encodeURIComponent(jql)}`;
    const id = `jql:${Bun.hash(jql).toString(36)}`;
    // The default first (shared/jiraSpaces.ts JiraAddChoice); the whole project is one click away.
    const alternatives: JiraAddChoice[] | undefined = view
      ? [{ kind: "jql", id, label: "Add as a search" }, { kind: "space", id: view[1], label: "Add the whole project" }]
      : undefined;
    return { ok: true, kind: "jql", id, url: canonical, jql, ...(alternatives && { alternatives }) };
  }
  return { ok: false, error: NOT_A_VIEW };
}

/** The search kept in a `jql:` view's address. */
export function jqlOfView(v: SavedView): string | null {
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
      ...(typeof c.max === "number" && c.max > 0 ? { max: c.max } : {}),
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

interface ViewRows extends JiraTasks { columns: JiraColumn[]; statuses?: ListStatus[]; statusBoard?: { id: string; name: string; key: string } }

// ---------------------------------------------------------------------------
// the statuses of a view
// ---------------------------------------------------------------------------

/** Jira's three status categories, in the order a workflow reads: to do, doing, done. */
const CATEGORY_RANK: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
/** The portable part of a ListStatus: `open` is to do, `custom` is in progress. */
const CATEGORY_TYPE: Record<string, string> = { new: "open", indeterminate: "custom", done: "done" };

/** The workflow statuses (`known`, a project's own list) among `ids` that no loaded card wears: each becomes a column with no cards. */
export function missingColumns(seen: readonly SeenStatus[], ids: readonly string[], known: readonly SeenStatus[], project: string): SeenStatus[] {
  const have = new Set(seen.map((x) => x.id));
  const want = new Set(ids);
  return known.filter((x) => want.has(x.id) && !have.has(x.id)).map((x) => ({ ...x, projects: [project] }));
}

const asListStatus = (s: SeenStatus, orderindex: number, wip?: number): ListStatus => ({
  status: s.name,
  type: CATEGORY_TYPE[s.category] ?? "custom",
  orderindex,
  ...(CATEGORY_COLOR[s.color] ? { color: CATEGORY_COLOR[s.color] } : {}),
  ...(wip ? { wip } : {}),
});

/**
 * The statuses of the project's issue TYPES, never of the cards loaded: a status is a column when some type of hierarchy
 * level 0 (standard) or -1 (sub-task) has it, so loading a Bug never adds or moves a column. A status only epic-level
 * types (level >= 1) have is left out unless the view shows epics. No level info on a status drops nothing.
 */
export function statusesOfIssueTypes<T extends WorkflowStatus>(flow: readonly T[], withEpics = false): T[] {
  return flow.filter((x) => withEpics || !x.levels?.length || x.levels.some((l) => l <= 0));
}

/** Cards' own statuses minus the ones only epic-level types of their project have: an Epic card the view never shows must not leave a column behind. */
export function withoutEpicOnly<T extends SeenStatus>(seen: readonly T[], epicOnly: ReadonlySet<string>): T[] {
  return seen.filter((x) => !x.projects.length || !x.projects.every((p) => epicOnly.has(`${p}|${x.id}`)));
}

const asSeen = (x: WorkflowStatus, project: string): SeenStatus => ({ id: x.id, name: x.name, category: x.category, color: x.color, projects: [project] });

/**
 * A board's statuses: EVERY status of its project's workflow, in workflow order (`projectStatuses`, the list the card's
 * own status menu comes from), a card on it or not. The board's own columns decide which cards it holds, not which
 * statuses exist, so a column's NAME is never a status. A project whose workflow cannot be read falls back to the
 * statuses its cards wear. A limit belongs to a column; it reads as one status's only when that column holds just the one.
 */
async function boardStatuses(creds: JiraCreds, cfg: BoardConfig, rows: JiraTasks): Promise<ListStatus[]> {
  const projects = cfg.projectKey ? [cfg.projectKey] : [...new Set(rows.tasks.map((t) => t.listId).filter((k): k is string => !!k))];
  const flow = new Map<string, SeenStatus>();
  for (const key of projects) {
    const r = await projectStatuses(creds, key);
    for (const x of statusesOfIssueTypes(r.ok && r.data ? r.data : [])) if (!flow.has(x.id)) flow.set(x.id, asSeen(x, key));
  }
  // The cards' own statuses fill what the workflow could not say (a project that refused the read).
  for (const x of rows.seen ?? []) if (!flow.has(x.id)) flow.set(x.id, x);
  const wip = new Map(cfg.columns.filter((c) => c.max && c.statusIds.length === 1).map((c) => [c.statusIds[0]!, c.max!]));
  /* Jira lists a project's statuses in no flow order, so the order is the board's own columns where it has them. A status
     no column holds goes by its category: to do before the first column, done after the last, the rest ahead of the
     first in-progress one. Ties keep Jira's order (the sort is stable). */
  const at = new Map<string, number>();
  cfg.columns.flatMap((c) => c.statusIds).forEach((id, i) => { if (!at.has(id)) at.set(id, i); });
  const doing = Math.min(Infinity, ...[...flow.values()].filter((x) => x.category === "indeterminate" && at.has(x.id)).map((x) => at.get(x.id)!));
  const lastTodo = Math.max(-1, ...[...flow.values()].filter((x) => x.category === "new" && at.has(x.id)).map((x) => at.get(x.id)!));
  const rank = (x: SeenStatus): number =>
    at.get(x.id) ?? (x.category === "new" ? -1 : x.category === "done" ? Number.MAX_SAFE_INTEGER : Number.isFinite(doing) ? doing - 0.5 : lastTodo + 0.5);
  return [...flow.values()].sort((a, b) => rank(a) - rank(b)).map((x, i) => asListStatus(x, i, wip.get(x.id)));
}

/**
 * The workflow statuses of every saved Jira project, upper case, once each: what the PR rules' "Card status is" offers.
 * The same `projectStatuses` the board's columns come from. Empty when Jira is not connected.
 */
export async function workflowStatusRead(extraProjects: readonly string[] = []): Promise<{ rows: { status: string; color?: string; type: string }[]; failed: boolean }> {
  let failed = false;
  const r = await withStored(async (creds) => {
    const seen: SeenStatus[] = [];
    /* The saved projects AND the projects of the cards on screen: a card's own status menu reads its project, saved or not. */
    const ids = [...new Set([...savedFolders(creds.site).map((f) => f.id), ...extraProjects])];
    // In parallel: a slow or refused project must not hold the others. A refused one adds nothing and erases nothing.
    const reads = await Promise.all(ids.map(async (id) => ({ id, r: await projectStatuses(creds, id) })));
    for (const { id, r } of reads) {
      if (!r.ok) failed = true;
      // Epic-only statuses (Work in progress, Warranty) are not a card's status on a PR.
      seen.push(...statusesOfIssueTypes(r.ok && r.data ? r.data : []).map((x) => asSeen(x, id)));
    }
    /* The order is the board's own: `viewStatuses`, the one the Jira board draws (the picked board's column order, an
       unlisted status beside its category). All of the workflow is "seen", so none is left out for wearing no card. */
    // Only the main project gets the board's order here: the lookup budget does not reach the others.
    const ordered = seen.length ? (await viewStatuses(creds, { tasks: [], seen } as unknown as JiraTasks)).statuses : [];
    const out = new Map<string, { status: string; color?: string; type: string }>();
    for (const x of ordered) {
      const status = x.status.toUpperCase();
      if (!out.has(status)) out.set(status, { status, type: x.type, ...(x.color ? { color: x.color } : {}) });
    }
    return { ok: true, data: [...out.values()] };
  });
  return { rows: r.data ?? [], failed };
}

export const workflowStatusRows = (): Promise<{ status: string; color?: string; type: string }[]> => workflowStatusRead().then((r) => r.rows);

/**
 * A project's own boards, by id and name: what `boardForProject` picks among,
 * and what the "Column order from board" picker lists. Kept ten minutes like
 * a board's configuration; a project with no board, or that cannot be read,
 * is remembered as none for two, so a site that refuses it is asked once and
 * not on every read. The same cache a saved project's `lists` already is, for
 * a project that is one: this is only asked when it is not.
 */
function boardsListOf(creds: JiraCreds, key: string): Promise<JiraResult<{ id: string; name: string }[]>> {
  return memoOk<{ id: string; name: string }[]>(creds, `boardlist:${key}`, async () => {
    const r = await boardsOfProject(creds, key);
    return r.ok ? { ok: true, data: r.data?.lists ?? [] } : { ...r, data: undefined };
  }, true);
}

/** A project's own boards, for the Settings picker. Does not add the project anywhere. */
export function projectBoards(key: unknown): Promise<JiraResult<{ id: string; name: string }[]>> {
  return withStored((creds) => {
    const k = typeof key === "string" ? key.trim().toUpperCase() : "";
    if (!KEY.test(k)) return Promise.resolve({ ok: false, error: "Pick a project from the list" });
    return boardsListOf(creds, k);
  });
}

/**
 * May the picked board's own configuration be fetched for it right now: free
 * when it is already answered (good or a remembered refusal), counted
 * against `budget` otherwise. This is the single-board case's only cost
 * (`automaticBoardOf` already spent its own share, once per project, when
 * there was a pick to make among several).
 */
function spendConfig(creds: JiraCreds, id: string, budget: { left: number }): boolean {
  if (memoHas(creds, `board:${id}`)) return true;
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
}

/**
 * Among a project's several boards, the one that gives a non-board view's
 * column order, when nobody picked one in Settings: the board already open
 * or already read (its own page is the strongest sign it is the one in use),
 * else the board whose filter restricts to nothing but this project (its
 * "main" board, by its own query), else the first Jira returned. A single
 * board skips all of it. The pick itself is cached per project (`boardpick:`)
 * so a board that keeps refusing is not re-explored on every read looking
 * for a different one to try.
 */
async function automaticBoardOf(creds: JiraCreds, key: string, lists: { id: string; name: string }[], budget: { left: number }): Promise<string | undefined> {
  if (lists.length <= 1) return lists[0]?.id;
  const current = currentView(creds.site);
  const used = lists.find((l) => `board:${l.id}` === current || cachedFor(creds.site, `board:${l.id}`));
  if (used) return used.id;
  const pickKey = `boardpick:${key}`;
  // The pick is one project's own work, done in full once bought: a project with several boards of its
  // own may check each one's filter and location, not stopped partway by the read's cross-project ceiling.
  // That ceiling instead gates whether THIS project gets to resolve at all this read (one newly-seen
  // project per read, same as the board list it needed first) - a later read picks up where this left off.
  if (!memoHas(creds, pickKey)) {
    if (budget.left <= 0) return undefined;
    budget.left--;
  }
  return (await memoOk<string>(creds, pickKey, async () => {
    const onlyThis = new RegExp(`^\\(?\\s*project\\s*=\\s*${key}\\s*\\)?$`, "i");
    const configs = new Map<string, BoardConfig>();
    for (const l of lists) {
      const cfg = await boardConfig(creds, l.id);
      // A board that answers, just not this tier's match, still leaves the next one worth asking.
      // One that is refused outright does not: Jira is saying something about the whole lookup, not that board alone.
      if (!cfg.ok || !cfg.data) break;
      configs.set(l.id, cfg.data);
      const f = await filterJql(creds, cfg.data.filterId);
      if (f.ok && f.data && onlyThis.test(splitOrder(f.data.jql).restriction)) return { ok: true, data: l.id };
    }
    // No board's own filter is exactly this project: the board whose own location says it is this project's,
    // else the one with the most columns (the fullest workflow is the likeliest "real" board), else the first.
    const located = lists.find((l) => configs.get(l.id)?.projectKey === key);
    if (located) return { ok: true, data: located.id };
    const byColumns = lists.filter((l) => configs.has(l.id)).sort((a, b) => configs.get(b.id)!.columns.length - configs.get(a.id)!.columns.length);
    return { ok: true, data: byColumns.length ? byColumns[0]!.id : lists[0]!.id };
  }, true)).data;
}

/**
 * The board a project reads its non-board column order from: its own setting
 * (the project's Settings row - the sidebar space's pick), else
 * `automaticBoardOf` among the project's own boards, read fresh when it is
 * not a saved folder.
 */
async function boardForProject(creds: JiraCreds, key: string, folder: SavedFolder | undefined, budget: { left: number }): Promise<string | undefined> {
  let lists = folder?.lists ?? [];
  if (!lists.length) {
    const r = await boardsListOf(creds, key);
    lists = r.ok ? r.data ?? [] : [];
  }
  if (!lists.length) return undefined;
  const explicit = spaceColumnBoard(key);
  if (explicit && lists.some((l) => l.id === explicit)) return explicit;
  return automaticBoardOf(creds, key, lists, budget);
}

/**
 * The statuses a filter, a search or "assigned to me" shows: the ones its
 * cards wear, merged by name across projects, in the column order of each
 * project's board - the one `boardForProject` picks - then category, then
 * name, with a status named "Done" always last in the done category even
 * there. Ceiling: a read pays for resolving at most one newly-seen project
 * (its board list and its configuration both), so a view across many saved
 * projects never costs more than the field list and one board on top of its
 * search; a project with several boards and no Settings pick may pay for
 * checking each one's filter too, until that answer is itself cached.
 */
async function viewStatuses(creds: JiraCreds, rows: JiraTasks): Promise<{ statuses: ListStatus[]; board?: { id: string; name: string; key: string }; unordered?: true }> {
  const seen = [...(rows.seen ?? [])];
  const position = new Map<string, number[]>();
  const folders = savedFolders(creds.site);
  const cards = new Map<string, number>();
  /* "Main" is the project holding most of the CARDS (a key's prefix). Counting the distinct statuses they wear instead let a
     project with fewer cards in more columns win it, and the other project's board order was then never read: measured, a
     first paint in the workflow's order that jumped to the board's order once the counts moved. */
  for (const t of rows.tasks ?? []) { const p = t.customId?.replace(/-\d+$/, ""); if (p) cards.set(p, (cards.get(p) ?? 0) + 1); }
  // A read with no cards (the PR rules' workflow list) has only the statuses to count.
  if (!cards.size) for (const x of seen) for (const p of x.projects) cards.set(p, (cards.get(p) ?? 0) + 1);
  // A project a card does not name (all its cards on a status another project's also wears) still gets its board.
  for (const x of seen) for (const p of x.projects) if (!cards.has(p)) cards.set(p, 0);
  let lookups = 1;
  const configBudget = { left: 1 };
  // The header names a board only when the whole view is one project's: across several, no single board answers for it.
  let board: { id: string; name: string; key: string } | undefined;
  let unordered = false;
  const epicOnly = new Set<string>();
  const noteEpicOnly = (key: string, rows: readonly WorkflowStatus[], onBoard?: ReadonlySet<string>) => {
    const keep = new Set(statusesOfIssueTypes(rows).map((x) => x.id));
    for (const x of rows) if (!keep.has(x.id) && !onBoard?.has(x.id)) epicOnly.add(`${key}|${x.id}`);
  };
  const byCards = [...cards.keys()].sort((a, b) => cards.get(b)! - cards.get(a)! || Number(folders.some((f) => f.id === b)) - Number(folders.some((f) => f.id === a)) || a.localeCompare(b));
  for (const key of byCards) {
    const folder = folders.find((f) => f.id === key);
    const known = folder?.lists?.length ? true : memoHas(creds, `boardlist:${key}`);
    /* The project most of the cards are in always gets its board's order, whatever the budget says: the budget is for
       the long tail of a cross-project view. Without it, a read that spent its one lookup elsewhere (or a cold start)
       drew a one-project view in category-and-name order, which moved Pre QA after Ready for QA between two reads and
       made a card's "next step" button name the wrong column. */
    const main = key === byCards[0];
    if (!known && !main) {
      if (lookups <= 0) { if (memoHas(creds, `statuses|${key}`)) { const c = await projectStatuses(creds, key); if (c.ok && c.data) noteEpicOnly(key, c.data); } continue; }
      lookups--;
    }
    /* It goes first (byCards) and takes the read's one configuration from the same budget, so a cold read of a
       cross-project view still asks for ONE configuration, the main project's, and the long tail waits its turn. */
    const first = await boardForProject(creds, key, folder, configBudget);
    if (!first) {
      /* No board for the main project is an order only when Jira said so (it has none); a refused list, or boards it could
         not choose among yet, leaves the order unknown, and an answer in category order must not be painted. */
      if (main) {
        const l = folder?.lists?.length ? folder.lists : await boardsListOf(creds, key);
        /* A list Jira refuses (403/404: the board is gone, or the person lost access) is a state, not a failure to retry: no order
           exists to wait for, so the read falls back to the workflow order and paints. Only a transient failure withholds it. */
        const gone = !Array.isArray(l) && !l.ok && (l.status === 403 || l.status === 404);
        if (!gone && (Array.isArray(l) ? l.length > 0 : !l.ok || !!l.data?.length)) { unordered = true; if (!Array.isArray(l) && !l.ok) forgetMiss(creds, `boardlist:${key}`); }
      }
      continue;
    }
    if (!spendConfig(creds, first, configBudget) && !main) continue;
    const cfg = await boardConfig(creds, first);
    /* A board that is gone or refused (403/404) has no order to wait for: the read stays, in category order. Anything
       else (a timeout, a 5xx) is not Jira's answer about the board, so it is not remembered and the read waits for the order. */
    if (main && !(cfg?.ok && cfg.data) && cfg?.status !== 403 && cfg?.status !== 404) { unordered = true; forgetMiss(creds, `board:${first}`); }
    const ids = cfg?.ok && cfg.data ? [...new Set(cfg.data.columns.flatMap((c) => c.statusIds))] : [];
    ids.forEach((id, i) => position.set(`${key}|${id}`, [...(position.get(`${key}|${id}`) ?? []), i]));
    /* Every status of the board's columns is a column, wearing a card or not: the statuses the cards wear are only the ones
       that happened to be loaded. Measured: QA COMPLETE vanished from "Assigned to me" when no loaded card sat in it. */
    const rowsOf = await projectStatuses(creds, key);
    /* A column of the board is a column whatever issue types the workflow gives its status to: a "Blocked" only the Epic
       type lists is still the board's own column, empty or not, so it is neither epic-only nor left out of the flow. */
    const onBoard = new Set(ids);
    if (rowsOf.ok && rowsOf.data) noteEpicOnly(key, rowsOf.data, onBoard);
    const flow = (rowsOf.ok && rowsOf.data ? rowsOf.data : []).filter((x) => onBoard.has(x.id) || statusesOfIssueTypes([x]).length).map((x) => asSeen(x, key));
    // A scope view's columns are the board's own (a card on another status joins them beside its category): the workflow says what each column IS, not which more there are.
    seen.push(...missingColumns(seen, ids, flow, key));
    if (cards.size === 1 && cfg.ok && cfg.data) board = { id: first, name: cfg.data.name, key };
  }
  const byName = new Map<string, { s: SeenStatus; at: number; rank: number; spaces: Set<string> }>();
  for (const x of withoutEpicOnly(seen, epicOnly)) {
    /* The same status, worn by a card of another project, sits where the board that WAS read puts it: a status id is one
       workflow's, so the read board's column is its column too. Without it the status fell off the board's order and
       was placed by its category, the first paint's wrong list. */
    const own = x.projects.flatMap((p) => (position.get(`${p}|${x.id}`) ?? []).map((at) => ({ p, at })));
    const places = own.length ? own : [...position].filter(([k]) => k.endsWith(`|${x.id}`)).flatMap(([k, v]) => v.map((at) => ({ p: k.slice(0, k.lastIndexOf("|")), at })));
    /* Two projects can each have a status of this NAME (their ids differ): the name is one column, and it sits where the
       board of the project most cards are in puts it, never where a smaller project's board does, whichever is earlier. */
    const best = places.map(({ p, at }) => ({ rank: byCards.indexOf(p), at })).sort((a, b) => a.rank - b.rank || a.at - b.at)[0];
    const at = best?.at ?? Infinity;
    const rank = best?.rank ?? Infinity;
    const k = x.name.toLowerCase();
    const have = byName.get(k);
    const spaces = new Set([...(have?.spaces ?? []), ...x.projects]);
    if (!have || rank < have.rank || (rank === have.rank && at < have.at)) byName.set(k, { s: x, at, rank, spaces });
    else have.spaces = spaces;
  }
  /* A status no column of the board holds (a "Blocked" or a "Won't do" the workflow has and the board does not show) is
     placed by its category, next to the board's own columns of that category, never in the order the cards came in:
     a to-do one after the board's last to-do column, an in-progress one before its first in-progress column, a done
     one after everything (so after Done). Ceiling: two such statuses of one category keep category-then-name between
     them, and a person who wants one elsewhere has nothing yet to move it with. */
  const placed = [...byName.values()].filter((x) => Number.isFinite(x.at));
  const edge = (cat: string, pick: "first" | "last"): number | undefined => {
    const ats = placed.filter((x) => x.s.category === cat).map((x) => x.at);
    return ats.length ? (pick === "first" ? Math.min(...ats) - 0.5 : Math.max(...ats) + 0.5) : undefined;
  };
  const offFlow = new Set<SeenStatus>();
  if (placed.length) for (const x of byName.values()) {
    if (Number.isFinite(x.at)) continue;
    offFlow.add(x.s);
    const at = x.s.category === "new" ? edge("new", "last") : x.s.category === "done" ? undefined : edge("indeterminate", "first") ?? edge("new", "last");
    x.at = at ?? Number.MAX_SAFE_INTEGER;
  }
  // Inside the done category, a status named "Done" never sorts by name: it is always the last of them.
  const doneName = (s: SeenStatus) => (s.category === "done" && s.name.toLowerCase() === "done" ? "￿" : s.name);
  return {
    statuses: [...byName.values()]
      .sort((a, b) => (a.at === b.at ? 0 : a.at - b.at) || (CATEGORY_RANK[a.s.category] ?? 1) - (CATEGORY_RANK[b.s.category] ?? 1) || doneName(a.s).localeCompare(doneName(b.s)))
      .map((x, i) => ({ ...asListStatus(x.s, i), ...(offFlow.has(x.s) ? { offFlow: true as const } : {}), ...(x.spaces.size ? { spaces: [...x.spaces] } : {}) })),
    ...(board ? { board } : {}),
    ...(unordered ? { unordered: true as const } : {}),
  };
}

/** The error of a view whose column order could not be read: such an answer is never sent on, so no column is ever drawn in a fallback order. */
const NO_ORDER = "Jira did not give the board's column order yet. Try again in a moment";

/** Most quick filters one read may AND in: a board does not define anywhere near this many, and each is a clause of the query. */
const MAX_QUICK = 8;

/**
 * The Mine chip and the people chip, read into one clause the search can AND in: "mine" (`assignee = currentUser()`) and
 * "people:<id>,<id>" (an account id each), OR'd together when both are pressed. Pressed together they mean "me, or any
 * of them" - never "me and also them" - so the board's own search answers for the union, not a fraction of 150 cards
 * filtered after the fact. A ridden-along id ASSIGNEE_ID rejects is dropped, never sent on.
 */
function assigneeQuickClause(ids: readonly string[]): string | null {
  let mine = false;
  const people: string[] = [];
  for (const id of ids) {
    if (id === "mine") mine = true;
    else if (id.startsWith("people:")) for (const p of id.slice(7).split(",")) if (ASSIGNEE_ID.test(p)) people.push(p);
  }
  const parts = [...(mine ? ["assignee = currentUser()"] : []), ...people.map((p) => `assignee = "${p}"`)];
  if (!parts.length) return null;
  return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0]!;
}

/**
 * The clauses of the quick filters asked for, from the board's OWN list, plus the Mine/people clause when either chip is
 * on. An id the board no longer has is refused with a sentence rather than dropped: a read that quietly ignored it would
 * show more cards than the person asked for.
 */
async function quickClauses(creds: JiraCreds, board: string, ids: readonly string[]): Promise<JiraResult<string[]>> {
  const assignee = assigneeQuickClause(ids);
  const out: string[] = assignee ? [assignee] : [];
  const real = ids.filter((id) => id !== "mine" && !id.startsWith("people:"));
  if (!real.length) return { ok: true, data: out };
  if (real.length > MAX_QUICK) return { ok: false, error: "Too many quick filters at once" };
  const all = await quickFilterRows(creds, board);
  if (!all.ok || !all.data) return { ...all, data: undefined };
  for (const id of real) {
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
      ...(!inSprint.data.truncated && rest.data.truncated ? { backlogCut: true } : null),
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

/** What a view holds, as one restriction a search can AND with: the search box's JQL on a board answers inside that board.
 *  Without it Jira answers for the whole site, and cards from other boards were shown on this one. */
export async function viewWhere(id: string, quick: readonly string[] = []): Promise<JiraResult<string>> {
  const board = /^board:(\d+)$/.exec(id);
  if (board) {
    return withStored(async (creds) => {
      const w = await boardWhere(creds, board[1]!, quick);
      return w.ok && w.data ? { ok: true, data: w.data.where.join(" AND ") } : { ...w, data: undefined };
    });
  }
  const site = connectedSite();
  const place = parseScope(id);
  const view = place ? null : savedViews(site ?? "").find((v) => v.id === id);
  const jql = place ? scopeJql(place) : view ? jqlForView(view) : null;
  const restriction = jql ? splitOrder(jql).restriction : "";
  return restriction ? { ok: true, data: `(${restriction})` } : { ok: false, error: "That view has no search behind it" };
}

/** The typed search inside a view's restriction; the typed order, if any, stays the order. */
export function scopedJql(where: string, typed: string): string {
  const t = splitOrder(typed);
  return `${where} AND (${t.restriction || "created IS NOT EMPTY"})${t.order ? ` ${t.order}` : ""}`;
}

export async function readBoard(creds: JiraCreds, id: string, quick: readonly string[] = []): Promise<JiraResult<ViewRows>> {
  const w = await boardWhere(creds, id, quick);
  if (!w.ok || !w.data) return { ...w, data: undefined };
  const { where, order, cfg, columns } = w.data;
  if (w.data.empty) return { ok: true, data: { tasks: [], truncated: false, columns, statuses: [] } };
  // Free where the board's header already asked: the sprint is remembered under the same key as its context.
  const sprint = await activeSprint(creds, id);
  const ask = { board: { points: cfg.estimationField, subEpics: true } };
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
  const { statuses, board, unordered } = await viewStatuses(creds, r.data);
  if (unordered) return { ok: false, error: NO_ORDER };
  return { ok: true, data: { ...rows, columns: [], statuses, ...(board ? { statusBoard: board } : {}) } };
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

/** The keys of the cards on an epic page that say they have sub-tasks: the only parents worth one more search. */
export const parentsWithSubtasks = (cards: readonly ProviderTask[]): string[] => cards.filter((t) => t.subtasks && t.customId).map((t) => t.customId!);

/**
 * An epic's page holds its sub-tasks too: a sub-task belongs to its parent's epic. Each one is marked with that epic (so the
 * board's epicOf agrees) and added once after the cards it sits under; a card already in the list is never doubled.
 */
export function withEpicSubtasks(cards: readonly ProviderTask[], subs: readonly ProviderTask[], epic: { key: string; title: string }): ProviderTask[] {
  const have = new Set(cards.map((t) => t.id));
  const out = [...cards];
  for (const t of subs) if (!have.has(t.id)) { have.add(t.id); out.push({ ...t, epic }); }
  return out;
}

/** The epic's own cards (`jql`, from scopeJql) plus their sub-tasks, in one view: the count, the columns and the cards agree. */
async function readEpicScope(creds: JiraCreds, jql: string, epic: string): Promise<JiraResult<ViewRows>> {
  const r = await searchJql(creds, jql, { board: {} });
  if (!r.ok || !r.data) return { ...r, data: undefined };
  const title = r.data.tasks.find((t) => t.parent?.key === epic)?.parent?.title ?? "";
  const parents = parentsWithSubtasks(r.data.tasks);
  let tasks = r.data.tasks;
  let truncated = r.data.truncated;
  const seen = new Map((r.data.seen ?? []).map((x) => [x.id, x] as const));
  for (let i = 0; i < parents.length; i += 100) {
    const subs = await searchJql(creds, `parent in (${parents.slice(i, i + 100).join(",")}) ORDER BY key ASC`, { board: {}, pages: 6 });
    if (!subs.ok || !subs.data) return { ...subs, data: undefined };
    tasks = withEpicSubtasks(tasks, subs.data.tasks, { key: epic, title });
    truncated = truncated || subs.data.truncated;
    // A sub-task's own status gets its column too.
    for (const x of subs.data.seen ?? []) if (!seen.has(x.id)) seen.set(x.id, x);
  }
  const { statuses, board, unordered } = await viewStatuses(creds, { ...r.data, tasks, truncated, seen: [...seen.values()] });
  if (unordered) return { ok: false, error: NO_ORDER };
  return { ok: true, data: { tasks, truncated, columns: [], statuses, ...(board ? { statusBoard: board } : {}) } };
}

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
    const { statuses, board, unordered } = await viewStatuses(creds, r.data);
    if (unordered) return { ok: false, error: NO_ORDER };
    return { ok: true, data: { ...rows, columns: [], statuses, ...(board ? { statusBoard: board } : {}) } };
  }
  const place = parseScope(view.id);
  if (place?.epic) return readEpicScope(creds, scopeJql(place), place.epic);
  if (place) return readJql(creds, scopeJql(place));
  const [kind, num] = view.id.split(":");
  if (kind === "board") return readBoard(creds, num, quick);
  if (kind === "filter") return readFilter(creds, num);
  const jql = kind === "jql" ? jqlOfView(view) : null;
  return jql ? readJql(creds, jql) : { ok: false, error: "That view has no search to run" };
}

/**
 * One saved view read now, and nothing else happens: it does not become "the
 * current view" and nothing is written back, so a background read — Polaris's
 * card signal — cannot move the board somebody is looking at.
 */
export function readViewNow(creds: JiraCreds, view: SavedView): Promise<JiraResult<ViewRows>> {
  return readView(creds, view, false);
}

let readFault: (() => void) | null = null;
/** Test seam: something that throws where a read begins, which no stand-in request can do. */
export const __setReadFault = (f: (() => void) | null): void => { readFault = f; };

function startRead(creds: JiraCreds, site: string, view: SavedView, force: boolean, quick: readonly string[] = []): Promise<JiraViewRead> {
  const gen = jiraGeneration();
  return Promise.resolve().then(() => { readFault?.(); return readView(creds, view, force, quick); }).then((r): JiraViewRead => {
    if (r.ok && r.data) {
      const at = Date.now();
      const out: JiraViewRead = {
        ok: true, view, tasks: r.data.tasks, columns: r.data.columns, ...(r.data.statuses ? { statuses: r.data.statuses } : null),
        ...(r.data.statusBoard ? { statusBoard: r.data.statusBoard } : null), at, ...(r.data.truncated ? { truncated: true } : null), ...(r.data.backlogCut ? { backlogCut: true } : null),
      };
      // A disconnect while this was in the air: the rows are not written back.
      // A narrowed read is a question of the moment: kept on disk it would be the board the next time it opens.
      if (gen === jiraGeneration() && !quick.length) {
        putCache(site, view.id, {
          view, tasks: out.tasks, columns: out.columns, ...(out.statuses ? { statuses: out.statuses } : null),
          ...(out.statusBoard ? { statusBoard: out.statusBoard } : null), at, ...(out.truncated ? { truncated: true } : null), ...(out.backlogCut ? { backlogCut: true } : null),
        });
      }
      return out;
    }
    // A failed read is never an empty board: the last good rows come back, said to be old.
    // Not for a narrowed one: the last rows kept are the whole board, and shown under a filter they would be wrong.
    const last = quick.length ? undefined : cachedFor(site, view.id);
    const error = r.error ?? "Could not read that view";
    return {
      ok: false, error, view, ...(r.throttled ? { throttled: true } : null), ...(r.unauthorised ? { unauthorised: true } : null),
      tasks: last?.tasks ?? [], columns: last?.columns ?? [], ...(last?.statuses ? { statuses: last.statuses } : null),
      ...(last?.statusBoard ? { statusBoard: last.statusBoard } : null), at: last?.at ?? 0,
      ...(last?.truncated ? { truncated: true } : null), ...(last?.backlogCut ? { backlogCut: true } : null), ...(last ? { cached: true } : null),
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
  // A place in the tree is a search that is never stored, and never becomes "the current view": the rail's own pick stays where it was.
  const place = id ? parseScope(id) : null;
  const view: SavedView | undefined = place
    ? { id: want, name: scopeName(place), url: `https://${site}/issues/?jql=${encodeURIComponent(scopeJql(place))}`, addedAt: 0 }
    : views.find((v) => v.id === want);
  if (!view) return emptyRead("That view is not saved any more");
  if (!place && want !== currentView(site)) setCurrent(site, want);

  // Quick filters narrow a board and nothing else; each distinct set is its own minute.
  const quick = want.startsWith("board:") ? [...new Set(o.quick ?? [])].sort() : [];
  if (o.cached && !quick.length) {
    const last = cachedFor(site, want);
    return last
      ? {
          ok: true, view, tasks: last.tasks, columns: last.columns, ...(last.statuses ? { statuses: last.statuses } : null),
          ...(last.statusBoard ? { statusBoard: last.statusBoard } : null), at: last.at, ...(last.truncated ? { truncated: true } : null), ...(last.backlogCut ? { backlogCut: true } : null), cached: true,
        }
      : { ok: true, view, tasks: [], columns: [], at: 0, cached: true };
  }

  const k = `${site}|${jiraAccount() ?? ""}|${want}${quick.length ? `|q:${quick.join(",")}` : ""}`;
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
    return NUM.test(id) ? [{ kind: "filter" as const, id, name: str(f.name) || `Filter ${id}`, jql: str(f.jql).slice(0, MAX_JQL) }] : [];
  });
  return { ok: true, data: list };
});

/** The person's favourite filters with the search behind each, from the same ten-minute memo the add-a-view list reads. */
export async function favouritesOf(creds: JiraCreds): Promise<JiraResult<JiraFavourite[]>> {
  const r = await favouriteFilters(creds);
  if (!r.ok || !r.data) return { ...r, data: undefined };
  return { ok: true, data: r.data.map((f) => ({ id: f.id, name: f.name, jql: f.jql ?? "" })) };
}

/** Boards (first page, by name) and favourite filters, each remembered ten minutes on its own, so one failing is not remembered. */
export async function viewChoices(creds: JiraCreds, query: string): Promise<JiraResult<ViewChoices>> {
  const q = query.trim().slice(0, 80);
  const [b, f] = await Promise.all([boardsPage(creds, q), favouriteFilters(creds)]);
  if (!b.ok && !f.ok) return { ...b, data: undefined };
  const needle = q.toLowerCase();
  const filters = f.ok && f.data ? f.data.filter((x) => !needle || x.name.toLowerCase().includes(needle)).map(({ jql: _jql, ...x }) => x) : [];
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

export type AddResult = { ok: true; view: SavedView; alternatives?: JiraAddChoice[] } | { ok: false; error: string };

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
    const r = await addResolved(creds, p.kind, p.id, p.url, p.jql);
    return { ok: true, data: r.ok && p.alternatives ? { ...r, alternatives: p.alternatives } : r };
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

// ---------------------------------------------------------------------------
// local saved queries: the address book only, Jira is asked for nothing
// ---------------------------------------------------------------------------

export type LocalViewResult = { ok: true; view: SavedView } | { ok: false; error: string };
const NAME_MAX = 120;

/** A search kept as a view must have a restriction, or it would read every card. */
function checkJql(raw: unknown): { jql: string } | { error: string } {
  const jql = typeof raw === "string" ? raw.trim() : "";
  if (!jql) return { error: "Type a search to save" };
  if (jql.length > MAX_JQL) return { error: "That search is too long to keep" };
  if (!splitOrder(jql).restriction) return { error: "That search has no restriction, so it would read every card. Add a project or an assignee to it" };
  return { jql };
}

function checkName(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!name) return { error: "Give it a name" };
  return { name: name.slice(0, NAME_MAX) };
}

const addressOf = (site: string, jql: string): string => `https://${site}/issues/?jql=${encodeURIComponent(jql)}`;
const NOT_STORED = "Only a saved search or filter of your own can change; a project's board comes with its project";

/**
 * Save a search as a `jql:` view, named as given. A search already saved keeps its row, and its name unless a new one is
 * given. The match is on the stored search, never the id: an edited view keeps the id of its first search.
 */
export function saveJqlView(rawJql: unknown, rawName?: unknown): LocalViewResult {
  const site = connectedSite();
  if (!site) return { ok: false, error: "Jira is not connected" };
  const j = checkJql(rawJql);
  if ("error" in j) return { ok: false, error: j.error };
  const unnamed = rawName === undefined || rawName === null || rawName === "";
  const n = unnamed ? { name: `Search: ${j.jql.slice(0, 40)}` } : checkName(rawName);
  if ("error" in n) return { ok: false, error: n.error };
  const all = savedViews(site);
  const had = all.find((v) => v.id.startsWith("jql:") && jqlOfView(v) === j.jql);
  let id = had?.id ?? `jql:${Bun.hash(j.jql).toString(36)}`;
  if (!had) {
    const taken = new Set(all.map((v) => v.id));
    const base = id;
    let k = 1;
    while (taken.has(id)) id = `${base}-${++k}`;
  }
  const view: SavedView = { ...had, id, name: unnamed && had ? had.name : n.name, url: addressOf(site, j.jql), addedAt: had?.addedAt ?? Date.now() };
  upsertView(site, view);
  return { ok: true, view };
}

/** Rename, share with the team, or change the search of a `jql:` view. The id stays; a new search is a new address. */
export function editViewById(id: string, patch: { name?: unknown; team?: unknown; tab?: unknown; jql?: unknown }): LocalViewResult {
  const site = connectedSite();
  if (!site) return { ok: false, error: "Jira is not connected" };
  const view = savedViews(site).find((v) => v.id === id);
  if (!view || view.builtin || isFolderBoard(site, id)) return { ok: false, error: view?.builtin ? "The built-in view cannot change" : NOT_STORED };
  const out: Partial<Pick<SavedView, "name" | "team" | "tab" | "url">> = {};
  if (patch.name !== undefined) {
    const n = checkName(patch.name);
    if ("error" in n) return { ok: false, error: n.error };
    out.name = n.name;
  }
  if (patch.team !== undefined) {
    if (typeof patch.team !== "boolean") return { ok: false, error: "Shared with the team is yes or no" };
    out.team = patch.team;
  }
  if (patch.tab !== undefined) {
    if (typeof patch.tab !== "boolean") return { ok: false, error: "Show as tab is yes or no" };
    out.tab = patch.tab;
  }
  if (patch.jql !== undefined) {
    if (!id.startsWith("jql:")) return { ok: false, error: "Only a saved search can change its search" };
    const j = checkJql(patch.jql);
    if ("error" in j) return { ok: false, error: j.error };
    out.url = addressOf(site, j.jql);
  }
  if (!Object.keys(out).length) return { ok: false, error: "Nothing to change" };
  const next = patchView(site, id, out);
  return next ? { ok: true, view: next } : { ok: false, error: NOT_STORED };
}

/** A copy of a saved search (or of a filter, as the search that reads it) under a fresh id, named "<name> (copy)". */
export function duplicateViewById(id: string): LocalViewResult {
  const site = connectedSite();
  if (!site) return { ok: false, error: "Jira is not connected" };
  const view = savedViews(site).find((v) => v.id === id);
  if (!view || view.builtin) return { ok: false, error: "That view is not saved any more" };
  const f = /^filter:(\d{1,12})$/.exec(id);
  const jql = f ? `filter = ${f[1]}` : id.startsWith("jql:") ? jqlOfView(view) : null;
  if (!jql) return { ok: false, error: "Only a saved search or filter can be duplicated" };
  const taken = new Set(savedViews(site).map((v) => v.id));
  const base = `jql:${Bun.hash(jql).toString(36)}`;
  let copy = base, n = 1;
  while (taken.has(copy)) copy = `${base}-${++n}`;
  const dup: SavedView = { id: copy, name: `${view.name} (copy)`.slice(0, NAME_MAX), url: addressOf(site, jql), addedAt: Date.now() };
  upsertView(site, dup);
  return { ok: true, view: dup };
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
