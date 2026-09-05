// What the browser view remembers between sessions.
//
// Its own module because two places need it and neither should own it: the view
// reads these, the settings pane writes them, and a key spelled out in both is
// one typo from a setting that saves and never applies.
//
// Read on use rather than cached in state. The workspace's views are mounted
// once and never torn down, so anything read into a `useState` initialiser is
// read exactly once per app launch — a home page changed in settings would not
// take effect until a restart, which is the kind of bug that looks like the
// setting is broken.
import { normalizeNavigationUrl, DEFAULT_SEARCH_ENGINE, type SearchEngine } from "./browserUrl.ts";

export const HOME_KEY = "agentglass.browser.home";
export const ENGINE_KEY = "agentglass.browser.engine";

/** Not Google, and deliberately. This is a tool that opens pages on your behalf
 *  while you work; the default should be the one that does not build a profile
 *  out of it. Anybody who wants Google can say so in settings. */
export const DEFAULT_HOME = "https://duckduckgo.com";
export const ZOOM_KEY = "agentglass.browser.zoom";

/** A blank page is a real answer — "open nothing" is what an empty home means,
 *  the same as every other browser. */
export const BLANK = "about:blank";

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* private mode, a full disk — losing a preference is not worth throwing over */ }
}

/**
 * The home page, as something safe to navigate to.
 *
 * Validated on the way out rather than only on the way in: the value could have
 * been written by an older build, hand-edited in devtools, or synced from
 * somewhere. Anything that is not http(s) becomes the blank page instead of
 * being handed to the guest.
 */
export function homePage(): string {
  const raw = read(HOME_KEY);
  // Nothing stored is "never chose", which is the default — not "chose blank".
  // Choosing blank stores `about:blank` explicitly, because clearing the key
  // would make the two indistinguishable and the choice unmakeable.
  if (!raw) return DEFAULT_HOME;
  if (raw === BLANK) return BLANK;
  return normalizeNavigationUrl(raw) ?? BLANK;
}

/** What the settings field shows. Blank comes back as an empty box, which is
 *  how it was chosen and how it is offered ("leave empty for a blank page"). */
export function homePageRaw(): string {
  const raw = read(HOME_KEY);
  return raw === BLANK ? "" : raw;
}

/** The stored value, or null when the input is not somewhere we would go — so
 *  the caller can say so rather than silently keeping the old one. */
export function setHomePage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) { write(HOME_KEY, BLANK); return BLANK; }
  const url = normalizeNavigationUrl(trimmed);
  if (!url) return null;
  write(HOME_KEY, url);
  return url;
}

export function searchEngine(): SearchEngine {
  const v = read(ENGINE_KEY);
  return v === "duckduckgo" || v === "bing" || v === "google" ? v : DEFAULT_SEARCH_ENGINE;
}

export function setSearchEngine(engine: SearchEngine): void {
  write(ENGINE_KEY, engine);
}


/**
 * How far the built-in browser is zoomed, as Electron's logarithmic LEVEL
 * rather than a percentage: 0 is 100%, each ±1 is a factor of 1.2.
 *
 * Remembered, because the alternative is re-zooming every launch — and the
 * people who reach for this are the ones for whom the default is unreadable,
 * so forgetting it is not a small annoyance. Held to the same range the shell
 * enforces, and a stored value that is not a number reads as "not zoomed"
 * rather than throwing this panel out of the workspace.
 */
export const ZOOM_MIN = -7;
export const ZOOM_MAX = 7;

export function zoomLevel(): number {
  try {
    const raw = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(raw) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, raw)) : 0;
  } catch { return 0; }
}

export function setZoomLevel(level: number): void {
  try {
    if (!Number.isFinite(level) || level === 0) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))));
  } catch { /* private mode */ }
}

/** What to show a person, who does not think in logarithms. Chrome's own
 *  ladder: 1.2^level, to the nearest whole percent. */
export const zoomPercent = (level: number): number => Math.round(Math.pow(1.2, level) * 100);

/**
 * ZOOM MOVES IN TENS.
 *
 * Chromium's own ladder is geometric — each step multiplies the last by 1.2^0.5
 * — so it walks 100, 110, 120, 132, 145, 158, 173. Every step is the same
 * proportion and no two are the same NUMBER, which is what makes it feel
 * arbitrary from the outside: "sometimes it goes up by five, sometimes by
 * three. That has to be something consistent."
 *
 * So the ladder is in percentage points instead: ten up, ten down, always. A
 * level that arrived from somewhere else — an old stored value, a pinch — lands
 * ON the grid with the first press rather than carrying its offset forever.
 *
 * The trade is real and worth saying once: ten points is a third of the way up
 * from 30% and a thirtieth from 300%, so the low end steps in bigger visual
 * jumps than the high end. That is what "always ten" means, and it is what was
 * asked for.
 */
export const ZOOM_PCT_MIN = 30;
export const ZOOM_PCT_MAX = 350;
export const ZOOM_PCT_STEP = 10;

const levelOfPercent = (pct: number): number => Math.log(pct / 100) / Math.log(1.2);

/** The next level in that ladder. `dir` is +1 for in, -1 for out. */
export function stepZoom(level: number, dir: 1 | -1): number {
  const now = Math.pow(1.2, level) * 100;
  const grid = Math.round(now / ZOOM_PCT_STEP) * ZOOM_PCT_STEP;
  /* Off the grid: the first press SNAPS, in the direction asked for, so 107%
     becomes 110 going up and 100 going down rather than 117 and 97. */
  const off = Math.abs(grid - now) > 0.6;
  const next = off
    ? (dir > 0 ? Math.ceil(now / ZOOM_PCT_STEP) : Math.floor(now / ZOOM_PCT_STEP)) * ZOOM_PCT_STEP
    : grid + dir * ZOOM_PCT_STEP;
  const held = Math.max(ZOOM_PCT_MIN, Math.min(ZOOM_PCT_MAX, next));
  return levelOfPercent(held);
}

/*
 * Whether history and bookmarks ride along with a cookie import.
 *
 * They used to come wholesale with the logins, no choice — the reasoning being
 * that a second button is one people miss, so the address bar stays empty for
 * whoever imported and never noticed it. True for the default, but a person who
 * wants only their logins in a work tool, not fifteen thousand pages of their
 * own history, had no way to say so. Two toggles, defaulting ON so nothing
 * changes for anyone who leaves them alone; stored as "0" only when turned OFF,
 * so an absent key is the on-by-default and can never be confused with a choice.
 */
export const IMPORT_HISTORY_KEY = "agentglass.browser.importHistory";
export const IMPORT_BOOKMARKS_KEY = "agentglass.browser.importBookmarks";

export function importHistory(): boolean { return read(IMPORT_HISTORY_KEY) !== "0"; }
export function setImportHistory(on: boolean): void { write(IMPORT_HISTORY_KEY, on ? "" : "0"); }
export function importBookmarks(): boolean { return read(IMPORT_BOOKMARKS_KEY) !== "0"; }
export function setImportBookmarks(on: boolean): void { write(IMPORT_BOOKMARKS_KEY, on ? "" : "0"); }

/**
 * Which imported rows to keep, given the two toggles.
 *
 * The reader marks each row as a bookmark or leaves it as history; this is the
 * one place that choice is applied, so the save and the "N pages" it reports
 * back always agree. Pure, so a test can pin that turning history off drops
 * exactly the non-bookmarks and nothing else.
 */
export function pickImportRows<T extends { bookmarked: boolean }>(
  rows: T[], history: boolean, bookmarks: boolean,
): T[] {
  return rows.filter((r) => (r.bookmarked ? bookmarks : history));
}

/* -------------------------------------------------------------- the inspector */

export const DEVTOOLS_SIDE_KEY = "agentglass.browser.devtoolsSide";
export const DEVTOOLS_SIZE_KEY = "agentglass.browser.devtoolsSize";

export type DevtoolsSide = "bottom" | "right";

/** Bottom by default, which is where Chrome puts it and where a DOM tree reads
 *  best — a tree is deep, not wide. Right is offered because a wide monitor has
 *  the room and a tall page does not. */
export function devtoolsSide(): DevtoolsSide {
  return read(DEVTOOLS_SIDE_KEY) === "right" ? "right" : "bottom";
}
export function setDevtoolsSide(side: DevtoolsSide): void {
  write(DEVTOOLS_SIDE_KEY, side === "right" ? "right" : "");
}

/** How big the pane is, in pixels — a height at the bottom, a width at the
 *  right. One number per side, because the two are not the same size and
 *  remembering only one makes the other wrong every time you switch. */
export function devtoolsSize(side: DevtoolsSide): number {
  const n = Number(read(`${DEVTOOLS_SIZE_KEY}.${side}`));
  if (Number.isFinite(n) && n >= 120 && n <= 1600) return n;
  return side === "right" ? 460 : 340;
}
export function setDevtoolsSize(side: DevtoolsSide, px: number): void {
  write(`${DEVTOOLS_SIZE_KEY}.${side}`, String(Math.round(px)));
}

export const DEVTOOLS_ZOOM_KEY = "agentglass.browser.devtoolsZoom";

/** The inspector's own zoom level, on the same logarithmic ladder as the page's
 *  (see ZOOM_MIN). Remembered because a level that resets every time the pane
 *  opens is no use to somebody who set it once because the default was too
 *  small to read. */
export function devtoolsZoom(): number {
  const n = Number(read(DEVTOOLS_ZOOM_KEY));
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX ? n : 0;
}
export function setDevtoolsZoom(level: number): void {
  write(DEVTOOLS_ZOOM_KEY, level ? String(level) : "");
}

/* ---------------------------------------------------------------- the bar */

export const SIDEBAR_OPEN_KEY = "agentglass.browser.sidebar";
export const SIDEBAR_W_KEY = "agentglass.browser.sidebarWidth";

/** Open unless it was closed. The bar IS the tab strip now — starting hidden
 *  would be starting with no way to see what is open. */
export function sidebarOpen(): boolean { return read(SIDEBAR_OPEN_KEY) !== "0"; }
export function setSidebarOpen(on: boolean): void { write(SIDEBAR_OPEN_KEY, on ? "" : "0"); }

/** 228px, which is what the mockup was drawn at: enough for a title of about
 *  thirty characters, which is where a page name stops being recognisable. */
export function sidebarWidth(): number {
  const n = Number(read(SIDEBAR_W_KEY));
  return Number.isFinite(n) && n >= 170 && n <= 460 ? n : 228;
}
export function setSidebarWidth(px: number): void { write(SIDEBAR_W_KEY, String(Math.round(px))); }
