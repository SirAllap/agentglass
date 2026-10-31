import { db } from "./db.ts";
import type { PrSummary } from "../../shared/types.ts";

/**
 * The details of a merged or closed pull request, kept for good.
 *
 * A finished pull request does not change, so its second-pass row (size, final
 * checks, reviews, the facts of how it ended) is read from GitHub once and then
 * answered from here: reopening the panel, restarting the app or scrolling back
 * costs no GitHub request. Keyed by repository + number, with the head commit
 * beside it: a row is replaced when a read brings another head.
 *
 * What is NOT stored is the tracker card's status chip: it follows the cards'
 * normal cache, so the caller recomputes it from `head` and `title` on every
 * answer. Ceiling: a pull request reopened and then pushed to keeps its old
 * row until a read of it (it is open by then, and open rows are never asked
 * for from here) writes the new one.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS pr_closed (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
`);

export interface StoredClosed {
  /** The row overlay: everything `completeRows` produced, without the tracker card. */
  row: Partial<PrSummary>;
  /** What `cardFor` needs to find the card again. */
  head: string;
  title: string;
}

/** Most a single read asks for, so the IN list stays small (the server's own row-details cap). */
const READ_MAX = 64;

export function readClosed(repo: string, numbers: number[]): Map<number, StoredClosed> {
  const out = new Map<number, StoredClosed>();
  const ns = numbers.filter((n) => Number.isInteger(n) && n > 0).slice(0, READ_MAX);
  if (!ns.length) return out;
  const rows = db.query(`SELECT number, body FROM pr_closed WHERE repo = ? AND number IN (${ns.map(() => "?").join(",")})`)
    .all(repo, ...ns) as { number: number; body: string }[];
  for (const r of rows) {
    try { out.set(r.number, JSON.parse(r.body) as StoredClosed); } catch { /* unreadable: it is read again */ }
  }
  return out;
}

export function writeClosed(repo: string, number: number, headSha: string, stored: StoredClosed): void {
  db.query(`INSERT INTO pr_closed (repo, number, head_sha, body, read_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo, number) DO UPDATE SET head_sha = excluded.head_sha, body = excluded.body, read_at = excluded.read_at`)
    .run(repo, number, headSha, JSON.stringify(stored), Date.now());
}

/** Drop a pull request's cached row (a cleanup after it ends); returns the rows removed. */
export function forgetClosed(repo: string, number: number): number {
  return db.query(`DELETE FROM pr_closed WHERE repo = ? AND number = ?`).run(repo, number).changes;
}
