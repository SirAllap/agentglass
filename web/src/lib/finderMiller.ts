/*
 * What the Machine tab's columns decide, apart from drawing them.
 *
 * There is no renderer in this project, so a rule that lives inside a component
 * can only be tested by reading its source. Everything that picks rows, orders
 * them, windows them or moves a cursor is a function here instead, and the
 * components only draw what these return. Measured with 100,000 entries: the
 * visible window is 35 DOM nodes however far the list is scrolled, which is
 * what `visibleWindow` is for and the only reason a folder that size scrolls.
 */
import { readListW } from "./finderList.ts";
import { fileKind } from "./paletteModel.ts";
import { READ_WIDTH_DEFAULT, readWidthOf, type ReadWidth } from "./finderPreview.ts";

/** One entry of a folder, as `/browse/list` reports it. */
export interface Row {
  name: string;
  kind: "dir" | "file" | "link";
  bytes: number | null;
  items: number | null;
  mtime: number;
  hidden: boolean;
  locked?: boolean;
  why?: string;
  /** A link to nothing: Strata draws it as a cross. */
  broken?: true;
}

/** Whether choosing this row opens its column: a folder that may be shown, with "Mirror columns selection" on. */
export const opensOnPick = (r: Pick<Row, "kind" | "items" | "locked">, mirror: boolean): boolean => mirror && isFolder(r) && !r.locked;

/** A folder, or a link the server found to lead to one it may show. */
export const isFolder = (r: Pick<Row, "kind" | "items">): boolean => r.kind === "dir" || (r.kind === "link" && r.items !== null);

/* ------------------------------------------------------------------- order */

export type SortKey = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);

/**
 * Folders first (Strata's "Folders first", on by default), then files — the order every file manager uses — and the
 * chosen key inside each. A folder has no size, so under "size" folders keep
 * name order; under "modified" they sort by date like everything else.
 * Returns a new array: the rows are the folder's own cache.
 */
export function sortRows(rows: readonly Row[], key: SortKey, dir: SortDir, foldersFirst = true): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  const ext = (r: Row) => (isFolder(r) || r.name.lastIndexOf(".") < 1 ? "" : r.name.slice(r.name.lastIndexOf(".") + 1).toLowerCase());
  const within = (a: Row, b: Row): number => {
    if (key === "type") return sign * collator.compare(ext(a), ext(b)) || byName(a, b);
    if (key === "size" && !(isFolder(a) === false && isFolder(b) === false)) return byName(a, b);
    if (key === "size") return sign * ((a.bytes ?? 0) - (b.bytes ?? 0)) || byName(a, b);
    if (key === "modified") return sign * (a.mtime - b.mtime) || byName(a, b);
    return sign * byName(a, b);
  };
  return [...rows].sort((a, b) => (!foldersFirst || isFolder(a) === isFolder(b) ? within(a, b) : isFolder(a) ? -1 : 1));
}

/** Hidden rows unless asked for, then the column's own filter (a substring of the name). */
export function filterRows(rows: readonly Row[], needle: string, showHidden: boolean): Row[] {
  const n = needle.trim().toLowerCase();
  return rows.filter((r) => (showHidden || !r.hidden) && (!n || r.name.toLowerCase().includes(n)));
}

/* ----------------------------------------------------------- group by type */

export const TYPE_GROUPS = ["Folders", "Documents", "Code", "Data", "Images", "Media", "Archives", "Other"] as const;
export type TypeGroup = (typeof TYPE_GROUPS)[number];

const EXTRA: Record<string, TypeGroup> = {};
for (const [g, list] of [
  ["Documents", "pdf doc docx odt rtf epub"],
  ["Media", "mp3 flac ogg wav m4a opus mp4 mkv webm mov avi"],
  ["Archives", "zip gz tgz tar xz bz2 7z rar zst"],
] as const) for (const e of list.split(" ")) EXTRA[e] = g;

const ofKind = { markdown: "Documents", code: "Code", image: "Images", data: "Data", file: "Other", dir: "Folders" } as const;

export function typeGroup(r: Pick<Row, "name" | "kind" | "items">): TypeGroup {
  if (isFolder(r)) return "Folders";
  const dot = r.name.lastIndexOf(".");
  const extra = dot > 0 ? EXTRA[r.name.slice(dot + 1).toLowerCase()] : undefined;
  return extra ?? ofKind[fileKind(r.name, false)];
}

export interface Grouped { header?: TypeGroup; row?: Row }

/** The rows with a header before each non-empty group, groups in a fixed order, rows in the order given. */
export function groupRows(rows: readonly Row[]): Grouped[] {
  const by = new Map<TypeGroup, Row[]>();
  for (const r of rows) { const g = typeGroup(r); (by.get(g) ?? by.set(g, []).get(g)!).push(r); }
  const out: Grouped[] = [];
  for (const g of TYPE_GROUPS) { const list = by.get(g); if (list) { out.push({ header: g }); for (const row of list) out.push({ row }); } }
  return out;
}

/* ------------------------------------------------------------ the window */

export interface Window { start: number; end: number; padTop: number; padBottom: number }

/** Which rows of a fixed-height list are in the DOM, and the padding that stands in for the rest. */
export function visibleWindow(o: { count: number; top: number; height: number; rowH: number; overscan: number }): Window {
  if (o.count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const end = Math.min(o.count, Math.ceil((Math.max(0, o.top) + o.height) / o.rowH) + o.overscan);
  const start = Math.min(end, Math.max(0, Math.floor(Math.max(0, o.top) / o.rowH) - o.overscan));
  return { start, end, padTop: start * o.rowH, padBottom: (o.count - end) * o.rowH };
}

/* ------------------------------------------------------------- the arrows */

export interface Cursor { col: number; row: number }
/** What a column tells the keyboard: how many rows, which is selected, which rows are folders. */
export interface ColShape { rows: number; sel: number | null; dirs: number[] }

/** Where an arrow key puts the cursor. Never throws and never leaves the grid. */
export function keyStep(at: Cursor, key: string, cols: readonly ColShape[], page = 10): Cursor {
  const col = cols[at.col];
  if (!col) return at;
  const last = col.rows - 1;
  switch (key) {
    case "ArrowDown": return col.rows ? { col: at.col, row: Math.min(last, at.row + 1) } : at;
    case "ArrowUp": return col.rows ? { col: at.col, row: Math.max(0, at.row - 1) } : at;
    case "PageDown": return col.rows ? { col: at.col, row: Math.min(last, at.row + Math.max(1, page)) } : at;
    case "PageUp": return col.rows ? { col: at.col, row: Math.max(0, at.row - Math.max(1, page)) } : at;
    case "Home": return col.rows ? { col: at.col, row: 0 } : at;
    case "End": return col.rows ? { col: at.col, row: last } : at;
    case "ArrowRight": {
      const next = cols[at.col + 1];
      return next && next.rows > 0 && col.dirs.includes(at.row) ? { col: at.col + 1, row: 0 } : at;
    }
    case "ArrowLeft": return at.col > 0 ? { col: at.col - 1, row: cols[at.col - 1]!.sel ?? 0 } : at;
    default: return at;
  }
}

/* ------------------------------------------------------------- the path bar */

export interface Crumb { label: string; path: string }

/** `/home/ann/Documents` as `~ / Documents`, every crumb knowing where it goes. */
export function crumbs(path: string, home: string): Crumb[] {
  if (isRecent(path)) return [{ label: "Recent", path: RECENT }];
  const h = home.replace(/\/+$/, "");
  const inHome = !!h && (path === h || path.startsWith(`${h}/`));
  const out: Crumb[] = [inHome ? { label: "~", path: h } : { label: "/", path: "/" }];
  const rest = (inHome ? path.slice(h.length) : path).split("/").filter(Boolean);
  let at = inHome ? h : "";
  for (const seg of rest) { at = `${at}/${seg}`; out.push({ label: seg, path: at }); }
  return out;
}

/**
 * Strata's path-bar menu, the right button anywhere on the bar (ui/browser/location.rs
 * hierarchy popover): the current folder first, then each one above it up to ~ or /,
 * home drawn as a house and the root as a disk. Which crumb was under the pointer
 * does not matter; the list is always the whole path.
 */
export function hierarchy(parts: readonly Crumb[]): (Crumb & { icon: "house" | "hard-drive" | "folder"; current: boolean })[] {
  return parts.map((c, i) => ({ ...c, current: i === parts.length - 1, icon: (i === 0 && c.label === "~" ? "house" : c.path === "/" ? "hard-drive" : "folder") as "house" | "hard-drive" | "folder" })).reverse();
}

/**
 * What a typed path offers: the folder it names and which of that folder's
 * subfolders start with what is left after the last slash. `dir` is null for a
 * spelling that is not absolute, which has no folder to ask — the server has no
 * working directory worth guessing from.
 */
export function completePath(input: string, home: string, dirs: readonly string[]): { dir: string | null; picks: string[] } {
  const full = input === "~" ? home : input.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${input.slice(2)}` : input;
  if (!full.startsWith("/")) return { dir: null, picks: [] };
  const cut = full.lastIndexOf("/");
  const dir = cut === 0 ? "/" : full.slice(0, cut);
  const part = full.slice(cut + 1).toLowerCase();
  return { dir, picks: dirs.filter((d) => d.toLowerCase().startsWith(part)) };
}

/** The path bar's Page Up / Page Down move the completion selection this far (Strata's step). */
export const COMPLETE_PAGE = 5;
/** The completion selection after a key: one step or a page, clamped to the list. */
export function stepPick(hot: number, n: number, by: number): number {
  return n === 0 ? 0 : Math.min(n - 1, Math.max(0, hot + by));
}

/**
 * Tab in the path bar, as Strata's: the selected candidate, else the only one, else the longest prefix
 * they share (when it says more than what is typed), else the selection moves down, wrapping.
 * `fill` is what the text after the last slash becomes; a whole folder gets its slash, a shared prefix does not.
 */
export function tabComplete(part: string, picks: readonly string[], hot: number, moved: boolean): { fill: string | null; hot: number } {
  if (picks.length === 0) return { fill: null, hot };
  if (moved && picks[hot] !== undefined) return { fill: `${picks[hot]}/`, hot };
  if (picks.length === 1) return { fill: `${picks[0]}/`, hot: 0 };
  const first = picks[0]!;
  let n = first.length;
  for (const p of picks) { let i = 0; while (i < n && i < p.length && p[i]!.toLowerCase() === first[i]!.toLowerCase()) i++; n = i; }
  if (n > part.length) return { fill: first.slice(0, n), hot: 0 };
  return { fill: null, hot: (hot + 1) % picks.length };
}

/** What a folder row's badge says. The server stops counting at 9999. */
export function itemsLabel(n: number | null): string {
  if (n === null) return "";
  if (n === 0) return "No items";
  return n >= 9999 ? "9999+ items" : n === 1 ? "1 item" : `${n} items`;
}

/* ------------------------------------------------------------- preferences */

export interface Prefs {
  view: "columns" | "icons" | "list";
  preview: boolean;
  density: "compact" | "airy";
  textSize: number;
  hidden: boolean;
  group: boolean;
  sizes: boolean;
  sidebar: boolean;
  /** With `sidebar` on: the icon rail instead of the full list. */
  rail: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Strata's "Folders first" in the sort menu. */
  foldersFirst: boolean;
  /** Strata's "Make this the default sort": what "Reset to default sort" goes back to. */
  defSort?: SortChoice;
  /** Icons view: the side of an image's thumbnail in pixels. */
  thumb: number;
  /** The full sidebar's width in pixels, as dragged. */
  sideW: number;
  /** The List view's column widths: Name (0 = the rest), Size, Type, Modified (lib/finderList). */
  listW: number[];
  /** The width a new column opens at: the last one dragged or fitted (Strata's browser_column_width). */
  colW: number;
  /** The reading column of a markdown or text preview: 66 / 80 / 100 characters or the whole pane. */
  readW: ReadWidth;
  /** Choosing a folder opens its column (Strata: "Mirror columns selection"). */
  mirror: boolean;
  /** The footer's "F1 Shortcuts" button. The key works either way. */
  f1: boolean;
  /** Strata's "Folder peeking": a card of what is inside a folder under the pointer, in Icons and List. */
  peek: boolean;
  /** Strata's "Autoplay media previews": video, audio and GIF previews start by themselves. */
  autoplay: boolean;
  /** Strata's "Render documents by default": Markdown and HTML open on the rendered view, not the source. */
  renderDocs: boolean;
  /** The sidebar places the person hid with Unpin (Strata's "show in sidebar" switches), by id. */
  hiddenPlaces: string[];
  /** The Ctrl+K search: by name, or inside the files. Remembered like the rest. */
  searchIn: "names" | "contents";
}

export interface SortChoice { sortKey: SortKey; sortDir: SortDir; foldersFirst: boolean }
export const BUILTIN_SORT: SortChoice = { sortKey: "name", sortDir: "asc", foldersFirst: true };
/** "Make this the default sort": the sort in force is remembered as the one to reset to. */
export const makeDefaultSort = (p: Pick<Prefs, "sortKey" | "sortDir" | "foldersFirst">): Pick<Prefs, "defSort"> => ({ defSort: { sortKey: p.sortKey, sortDir: p.sortDir, foldersFirst: p.foldersFirst } });
/** "Reset to default sort": the remembered default, or name ascending with folders first. */
export const resetSort = (p: Pick<Prefs, "defSort">): SortChoice => p.defSort ?? BUILTIN_SORT;
/** Is the sort in force the default one? (The menu offers neither action when it is.) */
export const isDefaultSort = (p: Pick<Prefs, "sortKey" | "sortDir" | "foldersFirst" | "defSort">): boolean => {
  const d = resetSort(p); return d.sortKey === p.sortKey && d.sortDir === p.sortDir && d.foldersFirst === p.foldersFirst;
};

export const THUMB_MIN = 32;
export const THUMB_MAX = 256;
export const THUMB_DEFAULT = 64;

export const TEXT_MIN = 11;
export const TEXT_MAX = 18;
/** Text size over the default: 1 at 13 px. The sizes a Finder file spells in px multiply by it (see `--fz` in index.css). */
export const fzScale = (textSize: number): number => textSize / 13;

export const DEFAULT_PREFS: Prefs = {
  view: "columns", preview: true, density: "compact", textSize: 13, hidden: false, group: false, sizes: true, sidebar: true, rail: false,
  sortKey: "name", sortDir: "asc", foldersFirst: true, thumb: THUMB_DEFAULT, sideW: 201, colW: 300, listW: [0, 90, 120, 150], readW: READ_WIDTH_DEFAULT, mirror: true, f1: true, peek: false, autoplay: false, renderDocs: true, hiddenPlaces: [], searchIn: "names",
};

function readSortChoice(v: unknown): SortChoice | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = (["name", "size", "modified", "type"] as const).find((k) => k === o.sortKey);
  const dir = (["asc", "desc"] as const).find((k) => k === o.sortDir);
  return key && dir && typeof o.foldersFirst === "boolean" ? { sortKey: key, sortDir: dir, foldersFirst: o.foldersFirst } : null;
}

/** Stored preferences, field by field: one that is missing or the wrong type falls back alone. */
export function readPrefs(raw: string | null): Prefs {
  let o: Record<string, unknown> = {};
  try { const p = raw ? JSON.parse(raw) : {}; if (p && typeof p === "object") o = p as Record<string, unknown>; } catch { /* a damaged value is the defaults */ }
  const d = DEFAULT_PREFS;
  const pick = <T extends string>(v: unknown, ok: readonly T[], dflt: T): T => (ok as readonly unknown[]).includes(v) ? (v as T) : dflt;
  const flag = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  const size = typeof o.textSize === "number" && Number.isFinite(o.textSize) ? Math.round(o.textSize) : d.textSize;
  return {
    view: pick(o.view, ["columns", "icons", "list"], d.view),
    preview: flag(o.preview, d.preview),
    density: pick(o.density, ["compact", "airy"], d.density),
    textSize: Math.min(TEXT_MAX, Math.max(TEXT_MIN, size)),
    hidden: flag(o.hidden, d.hidden),
    group: flag(o.group, d.group),
    sizes: flag(o.sizes, d.sizes),
    sidebar: flag(o.sidebar, d.sidebar),
    rail: flag(o.rail, d.rail),
    sortKey: pick(o.sortKey, ["name", "size", "modified", "type"], d.sortKey),
    sortDir: pick(o.sortDir, ["asc", "desc"], d.sortDir),
    foldersFirst: flag(o.foldersFirst, d.foldersFirst),
    ...(readSortChoice(o.defSort) ? { defSort: readSortChoice(o.defSort)! } : {}),
    thumb: typeof o.thumb === "number" && Number.isFinite(o.thumb) ? Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(o.thumb))) : d.thumb,
    sideW: typeof o.sideW === "number" && Number.isFinite(o.sideW) ? Math.min(360, Math.max(169, Math.round(o.sideW))) : d.sideW,
    listW: readListW(o.listW),
    colW: typeof o.colW === "number" && Number.isFinite(o.colW) ? Math.min(800, Math.max(300, Math.round(o.colW))) : d.colW,
    readW: readWidthOf(o.readW),
    mirror: flag(o.mirror, d.mirror),
    f1: flag(o.f1, d.f1),
    peek: flag(o.peek, d.peek),
    autoplay: flag(o.autoplay, d.autoplay),
    renderDocs: flag(o.renderDocs, d.renderDocs),
    searchIn: pick(o.searchIn, ["names", "contents"], d.searchIn),
    hiddenPlaces: Array.isArray(o.hiddenPlaces) ? o.hiddenPlaces.filter((x): x is string => typeof x === "string").slice(0, 40) : [],
  };
}

export const writePrefs = (p: Prefs): string => JSON.stringify(p);

/* ---------------------------------------------------------------- display */

export interface Display {
  /** What is drawn, top to bottom: group headers and rows, every item one row high. */
  items: Grouped[];
  /** The rows alone, in the order the keyboard walks them. */
  rows: Row[];
  /** For row i, where it sits in `items`. */
  itemOfRow: number[];
}

/** Filter, order and (optionally) group a folder's rows for one column. */
export function displayRows(all: readonly Row[], o: { needle: string; hidden: boolean; group: boolean; sortKey: SortKey; sortDir: SortDir; foldersFirst?: boolean; unsorted?: boolean }): Display {
  // `unsorted`: a folder still arriving that is too big to re-sort on every page; it is sorted once, when it is whole.
  const kept = filterRows(all, o.needle, o.hidden);
  const sorted = o.unsorted ? kept : sortRows(kept, o.sortKey, o.sortDir, o.foldersFirst ?? true);
  const items: Grouped[] = o.group ? groupRows(sorted) : sorted.map((row) => ({ row }));
  const rows: Row[] = [];
  const itemOfRow: number[] = [];
  items.forEach((it, i) => { if (it.row) { rows.push(it.row); itemOfRow.push(i); } });
  return { items, rows, itemOfRow };
}

/**
 * Recent's own sort (Strata: the sort menu of "recent:///" starts with "Recency", newest first, has no
 * "Folders first", and each visit starts on Recency again). Name, Size, Modified and Type work as anywhere.
 */
export type RecentSort = { key: SortKey | "recency"; dir: SortDir };
export const RECENT_SORT: RecentSort = { key: "recency", dir: "desc" };

/** The same key again reverses; another key starts ascending, except Recency, which starts newest first. */
export const nextRecentSort = (cur: RecentSort, key: SortKey | "recency"): RecentSort =>
  cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "recency" ? "desc" : "asc" };

/** What Recent draws: the server's order is last used, newest first; reversing it is Recency ascending. */
export function recentDisplay(all: readonly Row[], o: { needle: string; hidden: boolean; group: boolean }, sort: RecentSort): Display {
  if (sort.key !== "recency") return displayRows(all, { ...o, sortKey: sort.key, sortDir: sort.dir, foldersFirst: false });
  return displayRows(sort.dir === "desc" ? all : [...all].reverse(), { ...o, sortKey: "name", sortDir: "asc", unsorted: true });
}

/** Where an arrow key puts the selection in a grid of tiles `perRow` wide. */
export function gridStep(index: number, count: number, perRow: number, key: string, pageLines = 1): number {
  if (count <= 0) return 0;
  const to = (n: number) => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case "ArrowLeft": return to(index - 1);
    case "ArrowRight": return to(index + 1);
    case "ArrowUp": return to(index - Math.max(1, perRow));
    case "ArrowDown": return to(index + Math.max(1, perRow));
    case "Home": return 0;
    case "End": return count - 1;
    // A page is the lines on screen, a whole line at a time (Strata's page_selection).
    case "PageUp": return to(index - Math.max(1, perRow) * Math.max(1, pageLines));
    case "PageDown": return to(index + Math.max(1, perRow) * Math.max(1, pageLines));
    default: return index;
  }
}

/** Index of the row called `name`, or -1. */
export const indexOfName = (rows: readonly Row[], name: string | null): number => (name === null ? -1 : rows.findIndex((r) => r.name === name));

/** `/a/b/c` → `/a/b`; the root has no parent. */
export function parentOf(path: string): string | null {
  if (path === "/" || !path.startsWith("/")) return null;
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** The name of the one place that is a list rather than a folder: what the desktop's apps used lately, as Strata's Recent. */
export const RECENT = "recent:///";
export const isRecent = (path: string): boolean => path === RECENT;

/** A row's name is a name in its folder, except in Recent, where rows come from many folders and the name is the whole path. */
export const joinPath = (dir: string, name: string): string => (name.startsWith("/") ? name : dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`);

/** What a row is called on screen: its last segment, whether its name is one segment or a whole path. */
export const rowLabel = (name: string): string => (name.startsWith("/") ? name.slice(name.lastIndexOf("/") + 1) || name : name);

/** A long name cut in two for a middle ellipsis: the start may shrink, the tail (the last `keep` characters) never does. */
export const middleSplit = (text: string, keep = 8): [string, string] => (text.length <= keep * 2 ? [text, ""] : [text.slice(0, text.length - keep), text.slice(text.length - keep)]);

/** The row height a density and a text size draw: Strata's 26 (compact) and 42 (airy) at the default 13 px text, growing with it. */
export const rowHeight = (density: Prefs["density"], textSize: number): number => textSize + (density === "airy" ? 29 : 13);

const NOT_TEXT = new Set((
  "png jpg jpeg gif webp avif bmp ico heic heif tif tiff pdf mp3 flac ogg wav m4a opus mp4 mkv webm mov avi " +
  "zip gz tgz tar xz bz2 7z rar zst woff woff2 ttf otf so bin exe iso db sqlite o a class jar wasm"
).split(" "));

/** Whether "Open in nvim" is offered: not for what an editor would show as noise. An svg is text, and stays editable. */
export function canEdit(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || !NOT_TEXT.has(name.slice(dot + 1).toLowerCase());
}

/** "Open in nvim" for a row: a link is never offered, because the bench would follow it to wherever it points, outside the boundary this list was judged by. */
export const canEditRow = (r: Pick<Row, "name" | "kind" | "locked">): boolean => r.kind !== "link" && !r.locked && canEdit(r.name);

/* ----------------------------------------------------------------- sidebar */

export type SidebarMode = "full" | "rail" | "hidden";
export const sidebarMode = (p: Pick<Prefs, "sidebar" | "rail">): SidebarMode => (!p.sidebar ? "hidden" : p.rail ? "rail" : "full");

/** Strata's one toggle, for the button and Ctrl+B alike: full, then the icon rail, then hidden, then full again. */
export const nextSidebar = (m: SidebarMode): SidebarMode => (m === "full" ? "rail" : m === "rail" ? "hidden" : "full");
export const sidebarPrefs = (m: SidebarMode): Pick<Prefs, "sidebar" | "rail"> => ({ sidebar: m !== "hidden", rail: m === "rail" });

/** The tooltip names what the next press does, not what the sidebar is. */
export function sidebarTip(m: SidebarMode, keys: string): string {
  return m === "full" ? `Compact sidebar (${keys})` : m === "rail" ? `Hide sidebar (${keys})` : `Show sidebar (${keys})`;
}

/* ------------------------------------------------------------ footer count */

/** Decimal units, one decimal only when there is one: 999 B, 12.3 kB, 4 MB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = bytes, i = -1;
  do { v /= 1000; i++; } while (v >= 999.95 && i < units.length - 1);
  const t = Math.round(v * 10) / 10;
  return `${Number.isInteger(t) ? t : t.toFixed(1)} ${units[i]}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The count the footer shows for a folder: what the filter lets through while one is typed, the folder's own total otherwise. */
export const footerTotal = (total: number | null, shown: number, filter: string): number | null => (filter.trim() ? shown : total);

/** The right-hand side of the footer: what the column holds, or what is selected. */
export function footerCount(total: number | null, sel: Pick<Row, "kind" | "bytes" | "items"> | null): string {
  if (!sel) return total === null ? "" : plural(total, "item");
  if (isFolder(sel)) return "1 folder selected";
  return `1 file selected${sel.bytes === null ? " (size unavailable)" : ` (${formatSize(sel.bytes)})`}`;
}

/** What kind of thing a file is, in a word: the third part of the preview's "Size · Modified · Type". */
export function typeLabel(kind: string, mime: string, name: string): string {
  if (kind === "dir") return "Folder";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
  const base = kind === "text" ? "Text" : kind === "image" || kind === "image-convert" ? "Image" : kind === "pdf" ? "PDF document" : kind === "audio" ? "Audio" : kind === "video" ? "Video" : "Binary file";
  return ext && kind !== "pdf" && ext.length <= 5 ? `${base} (${ext})` : base || mime;
}

/** The List view's Type column: "Folder", or the extension said as a word. */
export function kindWord(r: Pick<Row, "name" | "kind" | "items">): string {
  if (isFolder(r)) return "Folder";
  const dot = r.name.lastIndexOf(".");
  return dot > 0 && dot < r.name.length - 1 ? `${r.name.slice(dot + 1).toUpperCase()} file` : "File";
}

/* ------------------------------------------------------------- icons view */

/**
 * A tile as Strata's Icons card measures it (ui/icons_cell.rs icons_card_extent): the picture with 6 px round it, a 4 px
 * gap, two 18 px lines of name, a 14 px details line and 4 px under it, in a slot that is never narrower than 120 px
 * with the 4 px between cards counted. `h` includes those 4 px between rows.
 */
export const CARD = { pad: 6, gap: 4, line: 18, lines: 2, details: 14, padY: 4, spacing: 4, minSlot: 120 } as const;
export const tileSize = (thumb: number): { w: number; h: number } => ({
  w: Math.max(thumb + CARD.pad * 2 + CARD.spacing, CARD.minSlot),
  h: thumb + CARD.pad * 2 + CARD.gap + CARD.line * CARD.lines + CARD.details + CARD.padY + CARD.spacing,
});

/**
 * The first item of the tile row at the top of an Icons view. Stored in items, not pixels: a tile row holds a different
 * number of tiles when the window is another width, and a pixel offset would land on another row. The part of the row
 * scrolled past rides as the decimals (0.86 = 86 % of a row), because rounding to the row put a reopened list up to
 * 107 px above where it was left (measured: 3333 came back as 3240).
 */
export const iconsFirstItem = (top: number, tileH: number, per: number): number => {
  const rows = Math.max(0, top) / tileH, row = Math.floor(rows);
  return row * per + Math.min(0.999, Math.round((rows - row) * 1000) / 1000);
};

/** The scrollTop that puts the tile row holding `item` at the top, and the decimals of it as far into that row as it was. */
export const iconsTopOf = (item: number, tileH: number, per: number): number => {
  const whole = Math.floor(Math.max(0, item));
  return Math.floor(whole / per) * tileH + Math.round((Math.max(0, item) - whole) * tileH);
};

export const tilesPerRow = (width: number, thumb: number): number => Math.max(1, Math.floor((width - 16) / tileSize(thumb).w));

const THUMBABLE = new Set("png jpg jpeg gif webp avif bmp ico svg".split(" "));

/** Whether the browser can draw this file as its own thumbnail. A name with no extension, or only a dot, is not a picture. */
export function isThumbable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && THUMBABLE.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Where a request from outside puts the finder: the palette's place, and the
 * file inside it when the request named one (a path clicked in a terminal).
 * A file wanted in some other folder than the place is not applied, so a stale
 * request cannot select a name in the wrong listing.
 */
export function externalPlace(start: string, want: { dir: string; name: string } | null): { dir: string; name: string | null } {
  const same = !!want && want.dir.replace(/\/+$/, "") === start.replace(/\/+$/, "");
  return { dir: start, name: same ? want!.name : null };
}

/**
 * What a folder target does when it arrives. The path field echoes the folder
 * the finder is already in back as a target (the palette keeps the text it was
 * given), and on a reopen that echo arrives AFTER the remembered selection was
 * restored: treating it as a move to a new folder cleared the file and its
 * preview. A target that names the folder the finder is in changes nothing.
 */
export function folderTargetMove(current: string, at: string, file: string | null): "stay" | { dir: string; name: string | null } {
  const same = current.replace(/\/+$/, "") === at.replace(/\/+$/, "");
  return same && !file ? "stay" : { dir: at, name: file };
}

/** Strata's line under the preview's file name: "43 B · Just now · text/markdown". A folder says its item count and has no type. */
const TEXT_MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", py: "text/x-python", json: "application/json", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  ts: "text/typescript", tsx: "text/typescript", rs: "text/rust", sh: "text/x-shellscript", yml: "application/yaml", yaml: "application/yaml", toml: "application/toml", txt: "text/plain",
};
/** The server calls every text file text/plain; Strata names the kind. A name this table does not know keeps what the server said. */
export const mimeFor = (name: string, mime: string): string => (mime.startsWith("text/plain") ? TEXT_MIME[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? mime : mime);

export function previewMetaLine(o: { folder: boolean; bytes: number | null; items: number | null; ago: string; mime: string; name?: string }): string {
  const when = o.ago ? o.ago[0]!.toUpperCase() + o.ago.slice(1) : "";
  const size = o.folder ? itemsLabel(o.items) : o.bytes !== null ? formatSize(o.bytes) : "";
  return [size, when, o.folder ? "" : mimeFor(o.name ?? "", o.mime).split(";")[0] ?? ""].filter(Boolean).join(" · ");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The filter box's placeholder: Strata counts the folder it filters. */
export const filterPlaceholder = (n: number): string => `Filter ${n === 1 ? "1 item" : `${n} items`}…`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a file changed, worded as Strata's relative dates are: "Just now", "5m ago", "3h ago", the weekday up to six days, "2w ago" up to thirty, then "Jul 4, 13:24" this year and "Jul 4, 2025" before. */
export function strataWhen(at: number, now = Date.now()): string {
  const span = now - at;
  const d = new Date(at), n = new Date(now);
  const pad = (v: number) => String(v).padStart(2, "0");
  const absolute = (withTime: boolean) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${withTime ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : d.getFullYear()}`;
  if (span < -60_000) return absolute(d.getFullYear() === n.getFullYear());
  const s = Math.floor(span / 1000);
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const midnight = (v: Date) => new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000);
  if (days === 0) return `${h}h ago`;
  if (days <= 6) return WEEKDAYS[d.getDay()]!;
  if (days <= 30) return `${Math.floor(days / 7)}w ago`;
  return absolute(d.getFullYear() === n.getFullYear());
}

/** The scrollTop that shows item `index` with the least movement: unchanged when it is already visible. */
export const scrollToReveal = (index: number, rowH: number, scrollTop: number, height: number): number => {
  const y = index * rowH;
  return y < scrollTop ? y : y + rowH > scrollTop + height ? y + rowH - height : scrollTop;
};

/** A selection that names a dotted entry needs the dotted entries listed, or the row it points at is not there to show. */
export const selectsHidden = (sel: readonly (string | null)[]): boolean => sel.some((n) => !!n && n.startsWith(".") && n !== "." && n !== "..");

/** Strata cuts one crumb's label in its middle past 32 characters ("ellipsize middle", max width 32 chars) and never shrinks a crumb to fit: a long path scrolls instead. */
export const CRUMB_MAX_CHARS = 32;
export function crumbLabel(label: string, max = CRUMB_MAX_CHARS): string {
  const chars = [...label];
  if (chars.length <= max) return label;
  const keep = max - 1, head = Math.ceil(keep / 2), tail = keep - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** Which edges of the scrolling path bar fade: the side that has more path past it. */
export function crumbFades(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
  return { left: scrollLeft > 1, right: scrollLeft + clientWidth < scrollWidth - 1 };
}
