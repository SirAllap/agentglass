/*
 * NOTICES THAT MUST NOT LAND IN THE PERSON'S BOX.
 *
 * A notice is typed into the seat's chat box. The adopted seat is the session
 * the person chats with, so a notice pasted while they were mid-sentence glued
 * onto their text and went out as one message. So a notice is typed only into
 * an empty, idle box; otherwise it waits here, keyed by pane, and leaves by one
 * of two doors: the UserPromptSubmit hook prints it as context on the seat's
 * next turn (without touching the box), or the next wake pass types it once the
 * box is empty.
 *
 * Ceiling: a hook only runs on a turn. An idle seat with a non-empty box is
 * woken when the box empties, not before. Small on purpose: at most CAP per
 * pane, de-duplicated by text, oldest dropped.
 */
import { db } from "./db.ts";

const CAP = 8;

db.run(`CREATE TABLE IF NOT EXISTS seat_notice (
  pane TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (pane, text)
)`);

const put = db.query<never, [string, string, number]>(`INSERT OR IGNORE INTO seat_notice (pane, text, at) VALUES (?, ?, ?)`);
const trim = db.query<never, [string, string, number]>(
  `DELETE FROM seat_notice WHERE pane = ? AND text NOT IN (SELECT text FROM seat_notice WHERE pane = ? ORDER BY at DESC, rowid DESC LIMIT ?)`);
const list = db.query<{ text: string }, [string]>(`SELECT text FROM seat_notice WHERE pane = ? ORDER BY at, rowid`);
const clear = db.query<never, [string]>(`DELETE FROM seat_notice WHERE pane = ?`);

export function parkNotice(pane: string, text: string, at = Date.now()): void {
  put.run(pane, text, at);
  trim.run(pane, pane, CAP);
}

export const pendingNotices = (pane: string): string[] => list.all(pane).map((r) => r.text);

/** Read and clear in one step: what is returned is what the caller delivers. */
export function takeNotices(pane: string): string[] {
  const out = pendingNotices(pane);
  if (out.length) clear.run(pane);
  return out;
}
