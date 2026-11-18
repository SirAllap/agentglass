/*
 * The search box's JQL run on the site, and the counts the sidebar shows beside a saved filter or search.
 *
 * A read only: Jira's search (POST /search/jql is a search, not a write) through the one stored connection. Each query is
 * kept 30 seconds, so a box retyped or a sidebar redrawn asks the site once, not per keystroke or per frame; a failure is
 * not kept. The board's own count comes from its kept read, never from a search. A sidebar count is a count-only call. The query is never logged.
 */
import { ASSIGNED_VIEW_ID, type SavedView } from "../../shared/providers.ts";
import { apiOf, boundedJql, jiraCall, jiraGeneration, searchJql, storedCreds, type JiraCreds, type JiraResult, type JiraTasks } from "./jira.ts";
import { jqlOfView, splitOrder } from "./jiraboards.ts";
import { cachedFor } from "./jiraviews.ts";

/**
 * Current sprint and Hide done, sent inside the search: the 1000-card cap then cuts what was asked for, not the site first
 * (measured: 1000 read, 41 left once the filters ran in the browser). The search goes in parentheses, its ORDER BY stays last,
 * and a clause it already holds is not added twice. Ceiling: only the running sprints; a named sprint still filters here.
 */
export function narrowJql(jql: string, n: { sprint: boolean; hideDone: boolean }): string {
  const { restriction, order } = splitOrder(jql);
  const add: string[] = [];
  if (n.sprint && !/\bopenSprints\s*\(/i.test(restriction)) add.push("sprint in openSprints()");
  if (n.hideDone && !/\bstatusCategory\s*(?:!=|<>|not\s+in)\s*\(?\s*["']?Done\b/i.test(restriction)) add.push("statusCategory != Done");
  if (!add.length) return jql;
  const head = restriction ? [`(${restriction})`, ...add] : add;
  return head.join(" AND ") + (order ? ` ${order}` : "");
}

export const JQL_TTL_MS = 30_000;
export const JQL_MAX = 2000;
const KEPT_MAX = 64;
/** The search box follows the site's pages until it says the list is complete, up to 20 x 50 = 1000 cards. */
export const SEARCH_PAGES = 20;
/** Typing shows the first page only; the whole walk runs on Enter. */
export const TYPING_PAGES = 1;
/** Sidebar counts: at most this many at once, and this many fresh site reads a minute, whatever asks. */
export const COUNT_SLOTS = 2;
export const COUNT_PER_MIN = 60;

/** How many cards a JQL query matches, read without the cards: Cloud's approximate count, Data Center's `total`. */
export async function jqlTotal(creds: JiraCreds, jql: string): Promise<number | undefined> {
  if (!boundedJql(jql)) return undefined;
  if (apiOf(creds) === 2) {
    const r = await jiraCall<{ total?: number }>(creds, "/rest/api/2/search", { method: "POST", optional: true, body: { jql, fields: ["key"], maxResults: 0 } });
    return r.ok && typeof r.data?.total === "number" ? r.data.total : undefined;
  }
  const r = await jiraCall<{ count?: number }>(creds, "/rest/api/3/search/approximate-count", { method: "POST", optional: true, body: { jql } });
  return r.ok && typeof r.data?.count === "number" ? r.data.count : undefined;
}

type Run = (jql: string, pages: number, signal: AbortSignal) => Promise<JiraResult<JiraTasks>>;
const live: Run = async (jql, pages, signal) => {
  const c = storedCreds();
  if (!c) return { ok: false, error: "Jira is not connected" };
  const r = await searchJql(c, jql, { pages, board: {}, optional: true, signal });
  // Past the cap the board says "showing N of M", so it needs M: one count read, only when the cap was hit.
  if (!r.ok || !r.data?.truncated || pages < SEARCH_PAGES || signal.aborted) return r;
  const total = await jqlTotal(c, jql);
  return total === undefined ? r : { ...r, data: { ...r.data, matching: total } };
};
let run: Run = live;
/* The seam forgets the per-minute count budget too: tests share one process, and a budget spent by an earlier file read as "Too many counts" here. */
export function __setRun(r: Run | null): void { run = r ?? live; kept.clear(); counted.clear(); fresh.length = 0; }

interface Entry { at: number; r: Promise<JiraResult<JiraTasks>>; ctl: AbortController; waiters: number }
const kept = new Map<string, Entry>();

/** A card write (assignee, status) changes what a kept answer would say: every kept search is dropped, so the next ask reads the site. */
export const forgetJqlReads = (): void => { kept.clear(); };

/**
 * The cards a JQL query answers, kept 30 seconds per site, query and depth. A caller's `signal` ends its wait; the walk on the
 * site stops once every caller that passed one has gone (a caller with no signal keeps it running).
 */
export function runJql(jql: string, o: { pages?: number; now?: number; signal?: AbortSignal; fresh?: boolean } = {}): Promise<JiraResult<JiraTasks>> {
  const q = jql.trim();
  if (!q) return Promise.resolve({ ok: false, error: "Type a search" });
  if (q.length > JQL_MAX) return Promise.resolve({ ok: false, error: "That search is too long" });
  const pages = o.pages ?? SEARCH_PAGES;
  const now = o.now ?? Date.now();
  // The generation moves on every connect and disconnect, so another account's answer is never served.
  const key = `${jiraGeneration()}\n${storedCreds()?.site ?? ""}\n${pages}\n${q}`;
  let e = kept.get(key);
  // `fresh` (the board's Refresh) never takes a kept answer: a card that left the search since must leave the board.
  if (!e || o.fresh || now - e.at >= JQL_TTL_MS) {
    const ctl = new AbortController();
    const made: Entry = { at: now, ctl, waiters: 0, r: undefined as unknown as Promise<JiraResult<JiraTasks>> };
    made.r = run(q, pages, ctl.signal).then((res) => { if ((!res.ok || ctl.signal.aborted) && kept.get(key) === made) kept.delete(key); return res; });
    kept.set(key, made);
    if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
    e = made;
  }
  const entry = e;
  if (!o.signal) { entry.waiters = Infinity; return entry.r; }
  const sig = o.signal;
  if (sig.aborted) return Promise.resolve({ ok: false, error: "Cancelled" });
  entry.waiters++;
  return new Promise((resolve) => {
    const gone = () => {
      entry.waiters--;
      if (entry.waiters <= 0) { entry.ctl.abort(); if (kept.get(key) === entry) kept.delete(key); }
      resolve({ ok: false, error: "Cancelled" });
    };
    sig.addEventListener("abort", gone, { once: true });
    void entry.r.then((res) => { sig.removeEventListener("abort", gone); resolve(res); });
  });
}

const counted = new Map<string, { at: number; p: Promise<number | undefined> }>();
let counting = 0;
const queued: (() => void)[] = [];
const fresh: number[] = [];

/** Runs `f` once a count slot is free; a slot is handed straight to the next waiter, never released and re-raced. */
async function inSlot<T>(f: () => Promise<T>): Promise<T> {
  if (counting >= COUNT_SLOTS) await new Promise<void>((go) => queued.push(go)); else counting++;
  try { return await f(); } finally { const next = queued.shift(); if (next) next(); else counting--; }
}

/** A count's number, kept 30 seconds per site and query, asked through the slots and the per-minute budget. */
function countOf(jql: string, now: number): Promise<number | undefined> | "budget" {
  const key = `${jiraGeneration()}\n${storedCreds()?.site ?? ""}\n${jql}`;
  const hit = counted.get(key);
  if (hit && now - hit.at < JQL_TTL_MS) return hit.p;
  while (fresh.length && now - fresh[0]! >= 60_000) fresh.shift();
  if (fresh.length >= COUNT_PER_MIN) return "budget";
  fresh.push(now);
  const p = inSlot(async () => {
    const c = storedCreds();
    return c ? jqlTotal(c, jql) : undefined;
  }).then((n) => { if (n === undefined && counted.get(key)?.p === p) counted.delete(key); return n; });
  counted.set(key, { at: now, p });
  if (counted.size > KEPT_MAX) counted.delete(counted.keys().next().value!);
  return p;
}

/** What a person is called in a count request: an account id, or a login name or key. No quote, space or backslash can pass. */
export const ASSIGNEE_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * The view a count request names: a saved one, a board, a team member (`assignee:<id>`) or a favourite filter that is not saved
 * (`filter:<n>`). The query is built here from a validated id; the caller never sends one.
 */
export function countTarget(id: string, saved: readonly SavedView[]): Pick<SavedView, "id" | "url"> | undefined {
  if (id.startsWith("board:") || id === ASSIGNED_VIEW_ID) return { id, url: "" };
  const hit = saved.find((x) => x.id === id);
  if (hit) return hit;
  if (/^filter:\d{1,12}$/.test(id)) return { id, url: "" };
  if (id.startsWith("assignee:") && ASSIGNEE_ID.test(id.slice(9))) return { id, url: "" };
  return undefined;
}

/** The built-in "Assigned to me" as a search, so its badge counts like any other view. `statusCategory` is Jira's own, not a status name: keep it. */
export const ASSIGNED_JQL = "assignee = currentUser() AND statusCategory != Done";

/** The search behind a saved view, or null when it has none of its own (a board counts from its kept read). */
export function jqlForView(v: Pick<SavedView, "id" | "url">): string | null {
  if (v.id === ASSIGNED_VIEW_ID) return ASSIGNED_JQL;
  if (v.id.startsWith("assignee:")) return ASSIGNEE_ID.test(v.id.slice(9)) ? `assignee = "${v.id.slice(9)}"` : null;
  const filter = /^filter:(\d+)$/.exec(v.id);
  if (filter) return `filter = ${filter[1]}`;
  if (v.id.startsWith("jql:")) return jqlOfView(v as SavedView);
  return null;
}

export interface ViewCount { ok: boolean; count?: number; more?: boolean; error?: string }

/** How many cards a saved view holds: a board from its kept read, a filter or a search from a count-only call, never the cards. */
export async function viewCount(v: Pick<SavedView, "id" | "url"> | undefined, o: { now?: number } = {}): Promise<ViewCount> {
  if (!v) return { ok: false, error: "No such view" };
  if (v.id.startsWith("board:")) {
    const c = cachedFor(storedCreds()?.site ?? "", v.id);
    return c ? { ok: true, count: c.tasks.length, more: !!c.truncated } : { ok: false, error: "Not read yet" };
  }
  const jql = jqlForView(v);
  if (!jql) return { ok: false, error: "No search behind this view" };
  const n = countOf(jql, o.now ?? Date.now());
  if (n === "budget") return { ok: false, error: "Too many counts asked, try again shortly" };
  const total = await n;
  return total === undefined ? { ok: false, error: "Jira did not give a count" } : { ok: true, count: total, more: false };
}
