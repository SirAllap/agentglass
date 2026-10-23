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
import { fileKind } from "./paletteModel.ts";

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
}

/** Whether choosing this row opens its column: a folder that may be shown, with "Mirror columns selection" on. */
export const opensOnPick = (r: Pick<Row, "kind" | "items" | "locked">, mirror: boolean): boolean => mirror && isFolder(r) && !r.locked;

/** A folder, or a link the server found to lead to one it may show. */
export const isFolder = (r: Pick<Row, "kind" | "items">): boolean => r.kind === "dir" || (r.kind === "link" && r.items !== null);

/* ------------------------------------------------------------------- order */

export type SortKey = "name" | "size" | "modified";
export type SortDir = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: Row, b: Row) => collator.compare(a.name, b.name);

/**
 * Folders first, then files — the order every file manager uses — and the
 * chosen key inside each. A folder has no size, so under "size" folders keep
 * name order; under "modified" they sort by date like everything else.
 * Returns a new array: the rows are the folder's own cache.
 */
export function sortRows(rows: readonly Row[], key: SortKey, dir: SortDir): Row[] {
  const sign = dir === "asc" ? 1 : -1;
  const within = (a: Row, b: Row): number => {
    if (key === "size" && !(isFolder(a) === false && isFolder(b) === false)) return byName(a, b);
    if (key === "size") return sign * ((a.bytes ?? 0) - (b.bytes ?? 0)) || byName(a, b);
    if (key === "modified") return sign * (a.mtime - b.mtime) || byName(a, b);
    return sign * byName(a, b);
  };
  return [...rows].sort((a, b) => (isFolder(a) === isFolder(b) ? within(a, b) : isFolder(a) ? -1 : 1));
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
  const h = home.replace(/\/+$/, "");
  const inHome = !!h && (path === h || path.startsWith(`${h}/`));
  const out: Crumb[] = [inHome ? { label: "~", path: h } : { label: "/", path: "/" }];
  const rest = (inHome ? path.slice(h.length) : path).split("/").filter(Boolean);
  let at = inHome ? h : "";
  for (const seg of rest) { at = `${at}/${seg}`; out.push({ label: seg, path: at }); }
  return out;
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
  /** Icons view: the side of an image's thumbnail in pixels. */
  thumb: number;
  /** The full sidebar's width in pixels, as dragged. */
  sideW: number;
  /** Choosing a folder opens its column (Strata: "Mirror columns selection"). */
  mirror: boolean;
  /** The footer's "F1 Shortcuts" button. The key works either way. */
  f1: boolean;
}

export const THUMB_MIN = 32;
export const THUMB_MAX = 256;
export const THUMB_DEFAULT = 64;

export const TEXT_MIN = 11;
export const TEXT_MAX = 18;

export const DEFAULT_PREFS: Prefs = {
  view: "columns", preview: true, density: "compact", textSize: 13, hidden: false, group: false, sizes: true, sidebar: true, rail: false,
  sortKey: "name", sortDir: "asc", thumb: THUMB_DEFAULT, sideW: 201, mirror: true, f1: true,
};

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
    sortKey: pick(o.sortKey, ["name", "size", "modified"], d.sortKey),
    sortDir: pick(o.sortDir, ["asc", "desc"], d.sortDir),
    thumb: typeof o.thumb === "number" && Number.isFinite(o.thumb) ? Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(o.thumb))) : d.thumb,
    sideW: typeof o.sideW === "number" && Number.isFinite(o.sideW) ? Math.min(360, Math.max(169, Math.round(o.sideW))) : d.sideW,
    mirror: flag(o.mirror, d.mirror),
    f1: flag(o.f1, d.f1),
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
export function displayRows(all: readonly Row[], o: { needle: string; hidden: boolean; group: boolean; sortKey: SortKey; sortDir: SortDir; unsorted?: boolean }): Display {
  // `unsorted`: a folder still arriving that is too big to re-sort on every page; it is sorted once, when it is whole.
  const kept = filterRows(all, o.needle, o.hidden);
  const sorted = o.unsorted ? kept : sortRows(kept, o.sortKey, o.sortDir);
  const items: Grouped[] = o.group ? groupRows(sorted) : sorted.map((row) => ({ row }));
  const rows: Row[] = [];
  const itemOfRow: number[] = [];
  items.forEach((it, i) => { if (it.row) { rows.push(it.row); itemOfRow.push(i); } });
  return { items, rows, itemOfRow };
}

/** Where an arrow key puts the selection in a grid of tiles `perRow` wide. */
export function gridStep(index: number, count: number, perRow: number, key: string): number {
  if (count <= 0) return 0;
  const to = (n: number) => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case "ArrowLeft": return to(index - 1);
    case "ArrowRight": return to(index + 1);
    case "ArrowUp": return to(index - Math.max(1, perRow));
    case "ArrowDown": return to(index + Math.max(1, perRow));
    case "Home": return 0;
    case "End": return count - 1;
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

export const joinPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`);

/** The row height a density and a text size draw: the text, and the room round it. */
export const rowHeight = (density: Prefs["density"], textSize: number): number => textSize + (density === "airy" ? 23 : 15);

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

/** A tile: the picture, a line or two of name, and room round them. Never smaller than the icon tile it replaced. */
export const tileSize = (thumb: number): { w: number; h: number } => ({ w: Math.max(112, thumb + 32), h: Math.max(92, thumb + 44) });

export const tilesPerRow = (width: number, thumb: number): number => Math.max(1, Math.floor((width - 16) / tileSize(thumb).w));

const THUMBABLE = new Set("png jpg jpeg gif webp avif bmp ico svg".split(" "));

/** Whether the browser can draw this file as its own thumbnail. A name with no extension, or only a dot, is not a picture. */
export function isThumbable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && THUMBABLE.has(name.slice(dot + 1).toLowerCase());
}
