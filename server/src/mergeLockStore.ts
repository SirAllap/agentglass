import { db } from "./db.ts";
import type { MergeLock, MergeLockItem } from "../../shared/mergeLock.ts";

/**
 * Merge locks, one row per repository + pull request number (shared/mergeLock.ts
 * says what a lock is). In the app's own database so a restart or a board
 * refresh keeps it. Whether a lock still holds is computed on read from the
 * clock; nothing here runs on a timer.
 *
 * `merge_lock_log` keeps every change, the person's "Unlock now" above all: an
 * override that ships a rollout step early must leave a trace of who and when.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS merge_lock (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  until_ms INTEGER,
  items TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  after_pr INTEGER,
  set_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, pr)
);
CREATE TABLE IF NOT EXISTS merge_lock_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  verb TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
`);

interface Row { repo: string; pr: number; until_ms: number | null; items: string; note: string; after_pr: number | null; set_at: number; updated_at: number }

function parseItems(s: string): MergeLockItem[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.filter((i) => i && typeof i.text === "string").map((i) => ({ id: String(i.id), text: i.text, done: i.done === true })) : [];
  } catch { return []; }
}
const toLock = (r: Row): MergeLock => ({
  repo: r.repo, number: r.pr, until: r.until_ms, items: parseItems(r.items), note: r.note, afterPr: r.after_pr, setAt: r.set_at, updatedAt: r.updated_at,
});

export function getLock(repo: string, pr: number): MergeLock | null {
  const r = db.query<Row, [string, number]>(`SELECT * FROM merge_lock WHERE repo = ? AND pr = ?`).get(repo, pr);
  return r ? toLock(r) : null;
}

export function locksOf(repo: string): MergeLock[] {
  return db.query<Row, [string]>(`SELECT * FROM merge_lock WHERE repo = ? ORDER BY pr`).all(repo).map(toLock);
}

function log(repo: string, pr: number, verb: string, detail: string, who: string, at: number): void {
  db.query(`INSERT INTO merge_lock_log (repo, pr, verb, detail, who, at) VALUES (?, ?, ?, ?, ?, ?)`).run(repo, pr, verb, detail, who, at);
}

export function putLock(a: { repo: string; pr: number; until: number | null; items: MergeLockItem[]; note: string; afterPr: number | null; who: string; now: number }): MergeLock {
  const had = getLock(a.repo, a.pr);
  db.query(
    `INSERT INTO merge_lock (repo, pr, until_ms, items, note, after_pr, set_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr) DO UPDATE SET until_ms = excluded.until_ms, items = excluded.items, note = excluded.note, after_pr = excluded.after_pr, updated_at = excluded.updated_at`,
  ).run(a.repo, a.pr, a.until, JSON.stringify(a.items), a.note, a.afterPr, a.now, a.now);
  log(a.repo, a.pr, had ? "edit" : "lock", JSON.stringify({ until: a.until, items: a.items.length, afterPr: a.afterPr }), a.who, a.now);
  return getLock(a.repo, a.pr)!;
}

/** Ticks or unticks one item. Null when there is no such lock or item. */
export function tickItem(repo: string, pr: number, itemId: string, done: boolean, who: string, now: number): MergeLock | null {
  const l = getLock(repo, pr);
  if (!l) return null;
  const item = l.items.find((i) => i.id === itemId);
  if (!item) return null;
  item.done = done;
  db.query(`UPDATE merge_lock SET items = ?, updated_at = ? WHERE repo = ? AND pr = ?`).run(JSON.stringify(l.items), now, repo, pr);
  log(repo, pr, done ? "tick" : "untick", item.text, who, now);
  return getLock(repo, pr);
}

/** Removes the lock. `verb` says how: the person's "unlock-now" override, or "remove" of a lock that no longer held. */
export function dropLock(repo: string, pr: number, verb: "unlock-now" | "remove", who: string, now: number): boolean {
  const gone = db.query(`DELETE FROM merge_lock WHERE repo = ? AND pr = ?`).run(repo, pr).changes > 0;
  if (gone) log(repo, pr, verb, "", who, now);
  return gone;
}

export function lockLog(repo: string, pr: number): { verb: string; detail: string; who: string; at: number }[] {
  return db.query<{ verb: string; detail: string; who: string; at: number }, [string, number]>(
    `SELECT verb, detail, who, at FROM merge_lock_log WHERE repo = ? AND pr = ? ORDER BY id`,
  ).all(repo, pr);
}
