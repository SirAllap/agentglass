/*
 * Keeping the pages brought over from another browser.
 *
 * Its own file rather than a table in the events database, and that is a
 * privacy decision rather than a filing one: this is somebody's browsing
 * history — fifteen thousand rows of it off the machine this was written for —
 * and it should be deletable by removing one file, without taking a month of
 * fleet telemetry with it.
 *
 * Written once per import and read on every keystroke in the address bar, so
 * the whole thing is loaded into memory on first use and kept there. Fifteen
 * thousand rows is about two megabytes; a query per keystroke against SQLite
 * would also work, and would put a synchronous read in the path of typing.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Place {
  url: string;
  title: string;
  visits: number;
  /** Seconds since 1970, or 0 when the browser never recorded one. */
  lastAt: number;
  bookmarked: boolean;
}

const FILE = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "agentglass",
  "places.db",
);

let override: string | null = null;
/** Test seam, so a suite never touches the developer's own history. */
export function __setPlacesPath(p: string | null): void { override = p; close(); }
const path = (): string => override ?? FILE;

let conn: Database | null = null;
let cache: Place[] | null = null;

function open(): Database {
  if (conn) return conn;
  mkdirSync(dirname(path()), { recursive: true });
  conn = new Database(path());
  conn.exec("PRAGMA journal_mode = WAL;");
  // Imported browsing history is private; keep the file 0600 like the token and
  // devices files rather than the 0644 SQLite creates, so another local user on
  // a shared box can't read it. WAL/SHM are spun up by the pragma above and
  // carry the same rows in transit, so they get the same mode.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { chmodSync(path() + suffix, 0o600); } catch { /* not created yet, or a fs without modes */ }
  }
  conn.exec(`CREATE TABLE IF NOT EXISTS places (
    url        TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    visits     INTEGER NOT NULL DEFAULT 0,
    last_at    INTEGER NOT NULL DEFAULT 0,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT ''
  )`);
  return conn;
}

function close(): void {
  try { conn?.close(); } catch { /* already gone */ }
  conn = null;
  cache = null;
}

/**
 * Replace what came from one browser, leaving the others alone.
 *
 * Keyed by source so importing Chrome twice does not double it, and importing
 * Chrome does not throw away what came from Zen. `INSERT OR REPLACE` on the
 * url means a page both browsers know is one row — with the higher visit count
 * of the two, because the alternative is the last import silently winning.
 */
export function saveFrom(source: string, places: Place[]): number {
  const db = open();
  const tx = db.transaction((rows: Place[]) => {
    db.query("DELETE FROM places WHERE source = ?").run(source);
    const put = db.query(
      `INSERT INTO places (url, title, visits, last_at, bookmarked, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title      = CASE WHEN length(excluded.title) > length(places.title) THEN excluded.title ELSE places.title END,
         visits     = MAX(places.visits, excluded.visits),
         last_at    = MAX(places.last_at, excluded.last_at),
         bookmarked = MAX(places.bookmarked, excluded.bookmarked)`,
    );
    for (const p of rows) {
      put.run(p.url, p.title ?? "", Math.max(0, p.visits | 0), Math.max(0, p.lastAt | 0), p.bookmarked ? 1 : 0, source);
    }
  });
  tx(places);
  cache = null;
  return places.length;
}

/**
 * Remember a page the built-in browser actually visited, so the address bar can
 * suggest your OWN history back — not only what was imported from another
 * browser. Until now nothing recorded a visit, so the completions only ever knew
 * the pages someone else's browser had already seen.
 *
 * UPSERT by url: a first visit lands with a count of 1; a re-visit bumps the
 * count and the time (which is exactly what the suggestion ranking reads), and
 * keeps the longer of the two titles. The source is 'agentglass', which holds
 * these rows apart from an imported browser's — saveFrom() DELETEs by source, so
 * re-importing Chrome or Zen never wipes your own history.
 */
export function recordVisit(url: string, title: string): void {
  // Real pages only: never about:blank, a data: URL, or the app's own scheme.
  if (!/^https?:\/\//i.test(url)) return;
  // Anti-bloat, matching the import path: a url is the primary key so an
  // absurdly long one is dropped whole, and the title is capped at 300.
  if (url.length > 4096) return;
  const cappedTitle = (title ?? "").slice(0, 300);
  const at = Math.floor(Date.now() / 1000);
  open().query(
    `INSERT INTO places (url, title, visits, last_at, bookmarked, source)
     VALUES ($url, $title, 1, $at, 0, 'agentglass')
     ON CONFLICT(url) DO UPDATE SET
       visits  = places.visits + 1,
       last_at = $at,
       title   = CASE WHEN length($title) > length(places.title) THEN $title ELSE places.title END`,
  ).run({ $url: url, $title: cappedTitle, $at: at });
  cache = null; // the in-memory allPlaces() snapshot is now stale
}

/** Everything, for the address bar. Held in memory: this is read on every
 *  keystroke and a synchronous SQLite query does not belong there. */
export function allPlaces(): Place[] {
  if (cache) return cache;
  try {
    const rows = open().query<{ url: string; title: string; visits: number; last_at: number; bookmarked: number }, []>(
      "SELECT url, title, visits, last_at, bookmarked FROM places",
    ).all();
    cache = rows.map((r) => ({
      url: r.url, title: r.title ?? "", visits: Number(r.visits ?? 0),
      lastAt: Number(r.last_at ?? 0), bookmarked: Number(r.bookmarked ?? 0) === 1,
    }));
  } catch {
    cache = [];
  }
  return cache;
}

export function placeCount(): { total: number; bookmarks: number; sources: string[] } {
  try {
    const db = open();
    const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM places").get()?.n ?? 0;
    const bookmarks = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM places WHERE bookmarked = 1").get()?.n ?? 0;
    const sources = db.query<{ source: string }, []>("SELECT DISTINCT source FROM places WHERE source <> ''").all().map((r) => r.source);
    return { total, bookmarks, sources };
  } catch {
    return { total: 0, bookmarks: 0, sources: [] };
  }
}

/** Throw the lot away. One file, one call — the reason this is not a table in
 *  the events database. */
export function forgetPlaces(): void {
  close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path() + suffix)) rmSync(path() + suffix); } catch { /* in use */ }
  }
}
