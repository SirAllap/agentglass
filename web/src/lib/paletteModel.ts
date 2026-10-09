// The file palette's decisions, pulled out of the screen so they can be tested.
//
// There is no renderer in this project, so a rule that lives inside a component
// is a rule nobody can break on purpose and watch go red. Everything here is a
// plain function of its arguments: a path in, the pieces of a bar out.

import type { DiskPlace } from "../../../shared/types.ts";
import { looksLikePath } from "./finderQuery.ts";

/** A path with home written as `~`, which is how the box shows one and how
 *  anybody types one. */
export function shortenHome(abs: string, home: string): string {
  if (home && (abs === home || abs.startsWith(`${home}/`))) return `~${abs.slice(home.length)}`;
  return abs;
}

/* ---------------------------------------------------------------- the path bar */

export interface PathSegment {
  label: string;
  /** Absolute: where clicking it goes. */
  path: string;
  /** The first segment of a path under home, drawn as the home icon and "Home". */
  home?: boolean;
  /** Where you are. Drawn bold, and the only one that is not a jump. */
  last: boolean;
}

/**
 * A path as a bar of buttons, the way a desktop file manager draws it.
 *
 * Under home the first segment is Home and the rest follow; anywhere else the
 * first is the filesystem root, so a path is never a run of names with nothing
 * to say where it starts. `/` is the separator between segments and is drawn by
 * the bar, not stored here.
 */
/**
 * Whether the finder must ask the machine for its places (and so for the home
 * directory). The Machine tab always does. Any other tab needs the home
 * directory only once a `~` is typed, and only until it is known: `~/` on the
 * Name tab resolved to `/Documents` until the Machine tab had been opened.
 * One request, then cached by the caller; no poll, nothing per keystroke.
 */
export function needsPlaces(tab: string, q: string, homeDir: string): boolean {
  return tab === "machine" || (!homeDir && q.trimStart().startsWith("~"));
}

export function pathBar(abs: string, home = ""): PathSegment[] {
  const parts = abs.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length) return [];
  const homeParts = home ? home.replace(/\/+$/, "").split("/").filter(Boolean) : [];
  const underHome = homeParts.length > 0 && homeParts.every((p, i) => parts[i] === p);
  const out: PathSegment[] = [];
  let at = "";
  if (underHome) {
    at = `/${homeParts.join("/")}`;
    out.push({ label: "Home", path: at, home: true, last: false });
  } else {
    out.push({ label: "/", path: "/", last: false });
  }
  for (const part of parts.slice(underHome ? homeParts.length : 0)) {
    at += `/${part}`;
    out.push({ label: part, path: at, last: false });
  }
  out[out.length - 1]!.last = true;
  return out;
}

/* --------------------------------------------------- what each tab remembers */

export type BrowseState = { q: string; browsePath: string | null };
export const NO_BROWSE: BrowseState = { q: "", browsePath: null };

/**
 * Each tab owns the folder it was looking at.
 *
 * The folder used to be one variable shared by all four tabs, so after walking
 * into ~/notes/memory in Machine, Name still drew that breadcrumb and listing
 * beside a scope pill that said something else. Leaving a tab files its state
 * away; arriving on one takes out ITS state, or the default when it has none.
 */
export function switchTab<T extends string>(
  stash: Partial<Record<T, BrowseState>>, from: T, current: BrowseState, to: T,
): { stash: Partial<Record<T, BrowseState>>; next: BrowseState } {
  const filed = { ...stash, [from]: current } as Partial<Record<T, BrowseState>>;
  return { stash: filed, next: filed[to] ?? NO_BROWSE };
}

/* ------------------------------------------------------------ the input text */

/**
 * What the box should say for a folder: the path itself, ending in a slash.
 *
 * A folder opened from somewhere else (a path clicked in a terminal, a segment
 * of the bar) used to leave the box empty under its placeholder, so nothing on
 * screen said where you were or gave you a path to edit. The trailing slash is
 * what makes it a folder rather than a name to find inside its parent.
 */
export function pathInputText(abs: string, home: string): string {
  const s = shortenHome(abs.replace(/\/+$/, "") || "/", home);
  return s.endsWith("/") ? s : `${s}/`;
}

/**
 * What the box says while the selection moves: the SELECTED item's own path,
 * so the box, the path bar and the centre header name the same thing. A file
 * is written out in full ("~/notes/todo.md"), a folder ends in a slash. The
 * box is only a mirror here — `dirText` is what the list still reads from it,
 * the folder the item is in, so a mirrored file name never filters the list
 * down to itself and the arrow keys keep having somewhere to go. Typing
 * replaces the mirror and the box is an ordinary query again.
 */
export function followBox(abs: string, isDir: boolean, home: string): { text: string; dirText: string } {
  const clean = abs.replace(/\/+$/, "") || "/";
  const cut = clean.lastIndexOf("/");
  const text = shortenHome(clean, home);
  return {
    text: isDir && !text.endsWith("/") ? `${text}/` : text,
    dirText: pathInputText(cut <= 0 ? "/" : clean.slice(0, cut), home),
  };
}

/** What focusing the box does to its text. A last query is selected so the
 *  first key replaces it; a path is somewhere to edit, so the caret goes to
 *  its end and nothing is selected. */
export const focusSelection = (value: string): "end" | "all" => (looksLikePath(value) ? "end" : "all");

/** Where the box and the folder go after a jump: the box follows only when it
 *  was already holding a path, so a plain search is not overwritten. */
export function afterJump(abs: string, home: string, boxHoldsPath: boolean): BrowseState {
  return { browsePath: abs, q: boxHoldsPath ? pathInputText(abs, home) : "" };
}

/* ------------------------------------------------------------- copy feedback */

export const COPIED_MS = 1500;

/** The label of a copy button: what it does, then what it did. The check mark
 *  is drawn beside it as an icon, so the words stay the same width in any font. */
export const copyLabel = (verb: string, copied: boolean): string => (copied ? "Copied" : verb);

/**
 * A flag that turns on and turns itself off. Timers are passed in so a test
 * needs no clock, and a second press restarts the wait instead of letting the
 * first one switch the label off early.
 */
export function flash(
  set: (on: boolean) => void, ms = COPIED_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, t) => setTimeout(fn, t), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): { fire: () => void; cancel: () => void } {
  let t: unknown = null;
  const cancel = () => { if (t !== null) { timers.clear(t); t = null; } };
  return {
    fire: () => { cancel(); set(true); t = timers.set(() => { t = null; set(false); }, ms); },
    cancel,
  };
}

/* ---------------------------------------------------- the "where" menu, as a sidebar */

export interface PlaceRow { path: string; name: string; sub: string; home: boolean; recent: boolean }

/** Last segment bold, parent muted: what a recent folder is called and where it lives. */
export function recentRow(path: string, home: string): PlaceRow {
  const clean = path.replace(/\/+$/, "") || "/";
  const cut = clean.lastIndexOf("/");
  const name = clean.slice(cut + 1) || "/";
  const parent = cut <= 0 ? "/" : clean.slice(0, cut);
  return { path: clean, name, sub: shortenHome(parent, home), home: false, recent: true };
}

/**
 * The menu as two sections, filtered by what was typed.
 *
 * Places are the machine's own list (icon, name, path muted); Recent is where
 * you have been lately, minus anything that is already a place or is the folder
 * you are in. `flat` is both sections in reading order, which is what the arrow
 * keys walk: a cursor is an index, and two lists would need two cursors.
 */
export function placeSections(
  places: DiskPlace[], recents: string[], current: string, needle: string, home: string,
): { places: PlaceRow[]; recent: PlaceRow[]; flat: PlaceRow[] } {
  const n = needle.trim().toLowerCase();
  const p = places
    .map((x): PlaceRow => ({ path: x.path, name: x.label, sub: shortenHome(x.path, home), home: x.path === home, recent: false }))
    .filter((r) => !n || `${r.name} ${r.sub}`.toLowerCase().includes(n));
  const r = recents
    .filter((x) => x !== current && !places.some((pl) => pl.path === x))
    .map((x) => recentRow(x, home))
    .filter((row) => !n || `${row.name} ${row.sub}`.toLowerCase().includes(n));
  return { places: p, recent: r, flat: [...p, ...r] };
}

/* ------------------------------------------------------------------ the rows */

export type FileKind = "dir" | "markdown" | "code" | "image" | "data" | "file";

const KIND_OF: Record<string, FileKind> = {};
for (const [kind, list] of [
  ["markdown", "md mdx txt rst"],
  ["code", "ts tsx js jsx mjs cjs py rb go rs java c h cpp cs php swift kt vue svelte html css scss sh bash zsh fish sql lua"],
  ["image", "png jpg jpeg gif webp svg avif bmp ico heic heif tif tiff"],
  ["data", "json jsonc yml yaml toml ini xml csv"],
] as const) for (const e of list.split(" ")) KIND_OF[e] = kind;

/** What a row is, for its icon: folder, note, code, picture, data, or just a file. */
export function fileKind(name: string, isDir: boolean): FileKind {
  if (isDir) return "dir";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KIND_OF[name.slice(dot + 1).toLowerCase()] ?? "file" : "file";
}

/** Folders before files, each group in the order it came. A folder is where
 *  you go next; a list that interleaves them makes you read every name to find
 *  the doors. */
export function dirsFirst<T extends { kind: string }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.kind === "dir"), ...rows.filter((r) => r.kind !== "dir")];
}

/* -------------------------------------------------------- open in a browser */

const BROWSABLE = /\.(html?|png|jpe?g|gif|webp|svg|avif|pdf)$/i;

/** Which files get an "Open in browser" button: pages, pictures and PDFs, the
 *  things a browser draws better than an editor does. Enter still opens the
 *  editor for them. */
export const canOpenInBrowser = (name: string): boolean => BROWSABLE.test(name);

/** The address a browser tab loads for a file: the engine's own page route,
 *  which judges the path like every other read. `origin` is the engine's. */
export const pageUrl = (origin: string, abs: string): string => `${origin}/preview/page?path=${encodeURIComponent(abs)}`;

/* ------------------------------------------------------------------- sizes */

/** Bytes as a listing says them. Rounded hard: a file list is scanned. */
export function humanBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

