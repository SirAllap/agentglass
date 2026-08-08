/*
 * Where you have already been, brought over from your own browser.
 *
 * Cookies made pages behind a login work. This is the other half of "it feels
 * like my browser": an address bar that completes what you type, because it
 * knows the fifteen thousand places you have been rather than nothing at all.
 *
 * Two shapes, and they disagree about everything:
 *
 *   Firefox family   places.sqlite — moz_places for history, moz_bookmarks
 *                    joined back to it for bookmarks. Times in MICROSECONDS
 *                    since 1970.
 *   Chrome family    History (sqlite, `urls`) for history, and Bookmarks — a
 *                    JSON FILE, not a database, and not encrypted, which is
 *                    why bookmarks come across from Chrome even where cookies
 *                    would not. Times in microseconds since 1601.
 *
 * Measured on this machine before any of it was written: Zen has 14,984 pages
 * and 2 bookmarks; Chrome has 333 pages and a Bookmarks file with the usual
 * three roots. The size difference is the whole reason for the ranking below —
 * fifteen thousand rows is not a list, it is a corpus.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export interface Place {
  url: string;
  title: string;
  /** How many times it was opened. Bookmarks arrive with 0 and are ranked by
   *  being bookmarked instead. */
  visits: number;
  /** Seconds since 1970, or 0 when the browser never recorded one. */
  lastAt: number;
  bookmarked: boolean;
}

/** Firefox stores microseconds since 1970; Chromium, microseconds since 1601.
 *  Getting these the wrong way round dates every page to either 1970 or 1601,
 *  and both look plausible enough in a list to survive a review. */
export const ffSeconds = (micros: number): number => (micros ? Math.floor(micros / 1_000_000) : 0);
export const chromeSeconds = (micros: number): number =>
  (micros ? Math.floor(micros / 1_000_000) - 11_644_473_600 : 0);

/** Only pages. A history full of `about:`, `moz-extension:` and `chrome://`
 *  rows is a history nobody wants completed against. */
export const isPage = (url: string): boolean => /^https?:\/\//i.test(url);

/* ------------------------------------------------------------ the readers */

export function readFirefoxPlaces(dbPath: string, limit = 20_000): Place[] {
  const conn = new Database(dbPath, { readonly: true });
  try {
    const hist = conn.query<{ url: string; title: string | null; visit_count: number; last_visit_date: number | null }, []>(
      `SELECT url, title, visit_count, last_visit_date
         FROM moz_places
        WHERE hidden = 0
        ORDER BY visit_count DESC, last_visit_date DESC
        LIMIT ${Number(limit) || 20_000}`,
    ).all();
    // type=1 is a bookmark; folders and separators are 2 and 3, and joining
    // without this brings every folder in as a page with no url.
    const marks = conn.query<{ url: string; title: string | null }, []>(
      `SELECT p.url AS url, COALESCE(b.title, p.title) AS title
         FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id
        WHERE b.type = 1`,
    ).all();
    return merge(
      hist.filter((r) => isPage(r.url)).map((r) => ({
        url: r.url, title: r.title ?? "", visits: Number(r.visit_count ?? 0),
        lastAt: ffSeconds(Number(r.last_visit_date ?? 0)), bookmarked: false,
      })),
      marks.filter((r) => isPage(r.url)).map((r) => ({
        url: r.url, title: r.title ?? "", visits: 0, lastAt: 0, bookmarked: true,
      })),
    );
  } finally {
    conn.close();
  }
}

export function readChromeHistory(dbPath: string, limit = 20_000): Place[] {
  const conn = new Database(dbPath, { readonly: true });
  try {
    const rows = conn.query<{ url: string; title: string | null; visit_count: number; last_visit_time: number | null }, []>(
      `SELECT url, title, visit_count, last_visit_time
         FROM urls
        WHERE hidden = 0
        ORDER BY visit_count DESC, last_visit_time DESC
        LIMIT ${Number(limit) || 20_000}`,
    ).all();
    return rows.filter((r) => isPage(r.url)).map((r) => ({
      url: r.url, title: r.title ?? "", visits: Number(r.visit_count ?? 0),
      lastAt: chromeSeconds(Number(r.last_visit_time ?? 0)), bookmarked: false,
    }));
  } finally {
    conn.close();
  }
}

/**
 * Chrome's bookmarks, out of a JSON file.
 *
 * Not a database and not encrypted — which is why bookmarks cross over from
 * Chrome on machines where the cookie key never would. The tree nests to any
 * depth and a folder is a node with `children`, so this walks rather than
 * assuming the three roots are flat.
 */
export function parseChromeBookmarks(json: string): Place[] {
  let root: unknown;
  try { root = JSON.parse(json); } catch { return []; }
  const out: Place[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 24) return;
    const n = node as { type?: string; url?: string; name?: string; children?: unknown[] };
    if (n.type === "url" && typeof n.url === "string" && isPage(n.url) && !seen.has(n.url)) {
      seen.add(n.url);
      out.push({ url: n.url, title: String(n.name ?? ""), visits: 0, lastAt: 0, bookmarked: true });
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  const roots = (root as { roots?: Record<string, unknown> })?.roots;
  for (const v of Object.values(roots ?? {})) walk(v, 0);
  return out;
}

export function readChromeBookmarks(filePath: string): Place[] {
  try { return parseChromeBookmarks(readFileSync(filePath, "utf8")); } catch { return []; }
}

/* ------------------------------------------------------------- putting it
 *                                                            together */

/**
 * One list from several, keyed by url.
 *
 * A page that is both visited and bookmarked must come out as ONE row that is
 * both — appending the two lists would give the address bar two entries for
 * the same address, which is the single most irritating thing a completion
 * list can do.
 */
export function merge(...lists: Place[][]): Place[] {
  const by = new Map<string, Place>();
  for (const list of lists) {
    for (const p of list) {
      const had = by.get(p.url);
      if (!had) { by.set(p.url, { ...p }); continue; }
      had.visits = Math.max(had.visits, p.visits);
      had.lastAt = Math.max(had.lastAt, p.lastAt);
      had.bookmarked = had.bookmarked || p.bookmarked;
      // The longer title is nearly always the real one: a bookmark keeps
      // whatever it was named, and history keeps the page's own <title>.
      if (p.title.length > had.title.length) had.title = p.title;
    }
  }
  return [...by.values()];
}
