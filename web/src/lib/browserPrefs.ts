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
