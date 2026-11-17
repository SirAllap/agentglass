/*
 * What sits around a board's cards: its quick filters, the sprint it is in the
 * middle of, and its epics (for their colour). Three reads of Jira Software,
 * each kept ten minutes per board (`memoOk`), so opening a board costs at most
 * three requests the first time and none for the next ten minutes, and
 * toggling a quick filter costs none of them: only the search it narrows.
 *
 * A board that has none of a thing answers an empty list here, never an error:
 * a kanban board has no sprint and no epic panel, and the site says so with a
 * 400 that is a normal "none" for a caller that cannot know which kind of board
 * it holds. A failure that is not that (a 5xx, a refusal) is not kept as news
 * longer than two minutes and does not stop the board from reading.
 *
 * The quick filter's query never leaves the server. The screen sends an id, the
 * server looks it up in the board's own list and ANDs that query into the
 * search, so a request cannot make this read anything the board does not offer.
 *
 * Ceilings, on purpose: a scrum board's active sprint only (a board with two
 * active sprints shows the first); no velocity, no burndown; epics are read for
 * their colour and name and the first 50 are enough for a board's header.
 */
import type { JiraBoardContext, JiraBoardEpic, JiraBoardNextSprint, JiraBoardSprint, JiraQuickFilter } from "../../shared/providers.ts";
import { epoch, jiraCall, memoOk, type JiraCreds, type JiraResult } from "./jira.ts";

const AGILE = "/rest/agile/1.0";
const NUM = /^\d{1,12}$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rowsOf = (d: unknown): Record<string, unknown>[] => (isObj(d) && Array.isArray(d.values) ? d.values.filter(isObj) : []);

export interface QuickFilterRow extends JiraQuickFilter { jql: string }

/** The board's own quick filters with their queries: server side only. */
export function quickFilterRows(creds: JiraCreds, board: string): Promise<JiraResult<QuickFilterRow[]>> {
  if (!NUM.test(board)) return Promise.resolve({ ok: true, data: [] });
  return memoOk<QuickFilterRow[]>(creds, `quickfilters:${board}`, async () => {
    const r = await jiraCall<unknown>(creds, `${AGILE}/board/${board}/quickfilter?maxResults=50`);
    if (!r.ok) return r.status === 400 || r.status === 404 ? { ok: true, data: [] } : { ...r, data: undefined };
    const out: QuickFilterRow[] = rowsOf(r.data).flatMap((q) => {
      const id = idText(q.id);
      const name = str(q.name).trim();
      const jql = str(q.jql).trim();
      return NUM.test(id) && name && jql ? [{ id, name, jql, ...(str(q.description).trim() ? { description: str(q.description).trim() } : {}) }] : [];
    });
    return { ok: true, data: out };
  }, true);
}

/** The board's active sprint, or none. A kanban board's 400 is none. */
export function activeSprint(creds: JiraCreds, board: string): Promise<JiraResult<JiraBoardSprint | null>> {
  if (!NUM.test(board)) return Promise.resolve({ ok: true, data: null });
  return memoOk<JiraBoardSprint | null>(creds, `sprint:${board}`, async () => {
    const r = await jiraCall<unknown>(creds, `${AGILE}/board/${board}/sprint?state=active&maxResults=10`);
    if (!r.ok) return r.status === 400 || r.status === 404 ? { ok: true, data: null } : { ...r, data: undefined };
    const s = rowsOf(r.data).find((x) => str(x.state).toLowerCase() === "active" && NUM.test(idText(x.id)) && str(x.name));
    if (!s) return { ok: true, data: null };
    const goal = str(s.goal).trim();
    return { ok: true, data: { id: idText(s.id), name: str(s.name), state: "active", start: epoch(s.startDate), end: epoch(s.endDate), ...(goal ? { goal } : {}) } };
  }, true);
}

/** Most pages of future sprints read: 5 x 50 is more than any board plans ahead. */
const FUTURE_PAGES = 5;
const sprintRow = (s: Record<string, unknown>): JiraBoardNextSprint => ({ id: idText(s.id), name: str(s.name), start: epoch(s.startDate), end: epoch(s.endDate) });

/**
 * Every future sprint of the board, in the board's own order, paged through (`isLast`). Jira lets a card go into any
 * of them, so the card menu's Sprint row lists them all. A kanban board's 400 is none.
 */
export function futureSprints(creds: JiraCreds, board: string): Promise<JiraResult<JiraBoardNextSprint[]>> {
  if (!NUM.test(board)) return Promise.resolve({ ok: true, data: [] });
  return memoOk<JiraBoardNextSprint[]>(creds, `futuresprints:${board}`, async () => {
    const out: JiraBoardNextSprint[] = [];
    for (let page = 0, at = 0; page < FUTURE_PAGES; page++) {
      const r = await jiraCall<unknown>(creds, `${AGILE}/board/${board}/sprint?state=future&startAt=${at}&maxResults=50`);
      if (!r.ok) {
        if (page > 0) break; // a later page that fails keeps what the first ones gave
        return r.status === 400 || r.status === 404 ? { ok: true, data: [] } : { ...r, data: undefined };
      }
      const rows = rowsOf(r.data);
      out.push(...rows.filter((x) => NUM.test(idText(x.id)) && str(x.name) && str(x.state || "future").toLowerCase() === "future").map(sprintRow));
      if (!rows.length || (isObj(r.data) && r.data.isLast !== false)) break;
      at += rows.length;
    }
    return { ok: true, data: out };
  }, true);
}

/** The soonest future sprint. Sprints come in the board's own order; the first dated one is the next, else the first. */
export async function nextSprint(creds: JiraCreds, board: string): Promise<JiraResult<JiraBoardNextSprint | null>> {
  const r = await futureSprints(creds, board);
  if (!r.ok) return { ...r, data: undefined };
  const rows = r.data ?? [];
  return { ok: true, data: rows.find((x) => x.start) ?? rows[0] ?? null };
}

/**
 * What an epic is called. The agile read gives `name` (the "Epic Name" field, which a project may leave empty)
 * and `summary` (the issue title, always there): measured on a site whose epics had no Epic Name, every row of the
 * Areas rail read as its key. The title is the name then; the key only when neither exists.
 */
export const epicName = (e: { name?: unknown; summary?: unknown }, key: string): string => str(e.name) || str(e.summary) || key;

/** The board's epics. A board with no epic panel is an empty list. */
export function boardEpics(creds: JiraCreds, board: string): Promise<JiraResult<JiraBoardEpic[]>> {
  if (!NUM.test(board)) return Promise.resolve({ ok: true, data: [] });
  return memoOk<JiraBoardEpic[]>(creds, `epics:${board}`, async () => {
    const r = await jiraCall<unknown>(creds, `${AGILE}/board/${board}/epic?maxResults=50`);
    if (!r.ok) return r.status === 400 || r.status === 404 ? { ok: true, data: [] } : { ...r, data: undefined };
    return { ok: true, data: rowsOf(r.data).flatMap((e) => {
      const key = str(e.key);
      const color = isObj(e.color) ? str(e.color.key) : "";
      return key ? [{ key, name: epicName(e, key), ...(color ? { color } : {}), ...(e.done === true ? { done: true } : {}) }] : [];
    }) };
  }, true);
}

/** The three reads together, as the screen draws them. One that failed leaves its part empty and says why. */
export async function boardContext(creds: JiraCreds, view: string, kindOf?: (creds: JiraCreds, board: string) => Promise<JiraResult<{ type: string }>>): Promise<JiraBoardContext> {
  // The screen knows a board as the view id it was saved under (`board:3`); the site knows it as 3.
  const board = view.replace(/^board:/, "");
  const [f, s, e] = await Promise.all([quickFilterRows(creds, board), activeSprint(creds, board), boardEpics(creds, board)]);
  // The next sprint is read whether or not one is active: with none the chip says what is next, and with one the card menu's
  // Sprint row offers it. Both it and the board's kind are kept reads, so this is one future-sprint read per ten minutes.
  const [fs, cfg] = await Promise.all([futureSprints(creds, board), s.data ? Promise.resolve(null) : kindOf ? kindOf(creds, board) : Promise.resolve(null)]);
  const failed = [f, s, e].find((x) => !x.ok);
  const next = fs.data ? (fs.data.find((x) => x.start) ?? fs.data[0]) : undefined;
  return {
    ok: !failed,
    ...(failed ? { error: failed.error ?? "Jira did not answer" } : {}),
    filters: (f.data ?? []).map(({ jql: _jql, ...q }) => q),
    ...(s.data ? { sprint: s.data } : {}),
    ...(next ? { next } : {}),
    ...(fs.data?.length ? { futures: fs.data } : {}),
    ...(cfg?.data?.type ? { boardType: cfg.data.type.toLowerCase() } : {}),
    epics: e.data ?? [],
  };
}
