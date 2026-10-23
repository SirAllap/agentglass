/*
 * What the Jira list draws from a saved view, apart from the screen so it can
 * be asserted: which column a card sits in, how a view without columns is
 * grouped, and the rows of the rail.
 */
import { ASSIGNED_VIEW_ID, ASSIGNED_VIEW_NAME } from "../../../shared/providers.ts";
import type { JiraColumn, ProviderTask, SavedFolder, SavedView } from "../../../shared/providers.ts";
import type { RailNode } from "./railTree.ts";

export interface TaskGroup { key: string; name: string; rows: ProviderTask[]; done: boolean }

/**
 * One group per board column, in the board's order, empty ones kept. A card
 * goes in the column holding its status id, never by the status's name (two
 * statuses may share one). Cards no column holds go in a trailing "Other",
 * which exists only when there are any.
 */
export function columnGroups(tasks: readonly ProviderTask[], columns: readonly JiraColumn[]): TaskGroup[] {
  const at = new Map<string, number>();
  columns.forEach((c, i) => { for (const id of c.statusIds) if (!at.has(id)) at.set(id, i); });
  const groups: TaskGroup[] = columns.map((c, i) => ({ key: `col:${i}`, name: c.name, rows: [], done: false }));
  const other: ProviderTask[] = [];
  for (const t of tasks) {
    const i = t.statusId != null ? at.get(t.statusId) : undefined;
    if (i == null) other.push(t); else groups[i].rows.push(t);
  }
  // A column is done when everything in it is: the board has no word for it.
  for (const g of groups) g.done = g.rows.length > 0 && g.rows.every((t) => t.statusKind === "done");
  if (other.length) groups.push({ key: "col:other", name: "Other", rows: other, done: false });
  return groups;
}

const ORDER = { open: 0, other: 1, done: 2 } as const;

/** A view without columns: one group per status name, open first, then other, then done; first seen first within. */
export function statusGroups(tasks: readonly ProviderTask[]): TaskGroup[] {
  const by = new Map<string, TaskGroup & { kind: ProviderTask["statusKind"] }>();
  for (const t of tasks) {
    const name = t.status || "No status";
    const k = `${t.statusKind}:${name}`;
    let g = by.get(k);
    if (!g) { g = { key: `st:${k}`, name, rows: [], done: t.statusKind === "done", kind: t.statusKind }; by.set(k, g); }
    g.rows.push(t);
  }
  return [...by.values()]
    .map((g, i) => ({ g, i }))
    .sort((a, b) => ORDER[a.g.kind] - ORDER[b.g.kind] || a.i - b.i)
    .map(({ g }) => ({ key: g.key, name: g.name, rows: g.rows, done: g.done }));
}

/** What a view id is, in a word for the rail's tooltip. */
export function viewKindLabel(id: string): string {
  if (id === ASSIGNED_VIEW_ID) return "Assigned to you";
  if (id.startsWith("board:")) return "Board";
  if (id.startsWith("filter:")) return "Saved filter";
  if (id.startsWith("jql:")) return "Search";
  return "View";
}

export interface RailEntry extends RailNode {
  /** `view` is a row that opens a view; `folder` is a project that holds boards. */
  kind: "view" | "folder";
  id: string;
  name: string;
  builtin?: boolean;
}

/**
 * The rail, top to bottom: the built-in view, loose views, then each folder
 * followed by its boards when it is open. A folder with no boards still shows.
 */
export function railEntries(views: readonly SavedView[], folders: readonly SavedFolder[], open: ReadonlySet<string> = new Set()): RailEntry[] {
  const out: RailEntry[] = [];
  const builtin = views.find((v) => v.builtin || v.id === ASSIGNED_VIEW_ID);
  out.push({ kind: "view", id: ASSIGNED_VIEW_ID, name: builtin?.name || ASSIGNED_VIEW_NAME, builtin: true, level: 0 });
  const known = new Set(folders.map((f) => f.id));
  for (const v of views) {
    if (v === builtin || v.id === ASSIGNED_VIEW_ID) continue;
    if (v.folderId && known.has(v.folderId)) continue;
    out.push({ kind: "view", id: v.id, name: v.name, level: 0 });
  }
  for (const f of folders) {
    const expanded = open.has(f.id);
    out.push({ kind: "folder", id: f.id, name: f.name, level: 0, expanded });
    if (!expanded) continue;
    for (const v of views) if (v.folderId === f.id) out.push({ kind: "view", id: v.id, name: v.name, level: 1 });
  }
  return out;
}

export interface ViewAnswer { ok: boolean; error?: string; throttled?: boolean; truncated?: boolean; cached?: boolean }

/**
 * What to say above a view's rows, if anything. Rows already on screen stay:
 * a failed read is never an empty board. Cards that came from disk are said to
 * be, quietly, and a read that failed over kept cards is not an alarm.
 */
export function viewNote(r: ViewAnswer, hadRows: boolean): { text: string; bad: boolean } | null {
  if (!r.ok) {
    const why = r.error || "Jira did not answer";
    return { text: hadRows ? `${why}. These are the cards from the last read.` : why, bad: !r.throttled && !hadRows };
  }
  if (r.cached && r.error) return { text: `${r.error}. These are the cards from the last read.`, bad: false };
  if (r.truncated) return { text: "Showing the most recently changed cards. Narrow it in Jira to see the rest.", bad: false };
  if (r.cached) return { text: "Showing the last read kept on this machine.", bad: false };
  return null;
}
