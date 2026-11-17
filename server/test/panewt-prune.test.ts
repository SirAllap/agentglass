/**
 * The legacy `pane_agent` table ages out with the notes.
 *
 * Nothing deleted from it: one row per pane id, for ever, and every start
 * copied the dead rows back into `pane_note` for the sweep to drop again.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensurePaneNoteTable, prunePaneNotes } from "../src/panewt.ts";

const DAY = 86_400_000;
const NOW = 200 * DAY;

function fresh(withLegacy: boolean): Database {
  const d = new Database(":memory:");
  if (withLegacy) d.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
  ensurePaneNoteTable(d);
  return d;
}
const ids = (d: Database, t: string) =>
  d.query<{ pane_id: string }, []>(`SELECT pane_id FROM ${t} ORDER BY pane_id`).all().map((r) => r.pane_id);

describe("pane note retention", () => {
  test("old legacy rows go, recent ones stay", () => {
    const d = fresh(true);
    const add = d.query("INSERT INTO pane_agent VALUES (?, 's', '/t.jsonl', '/home/dev/code/orbit', ?)");
    add.run("%1", NOW - 91 * DAY);
    add.run("%2", NOW - 10 * DAY);
    prunePaneNotes(d, NOW);
    expect(ids(d, "pane_agent")).toEqual(["%2"]);
  });

  test("a dead legacy row is not copied back at the next start", () => {
    const d = fresh(true);
    d.query("INSERT INTO pane_agent VALUES ('%3', 's', '/t.jsonl', '/home/dev/code/orbit', ?)").run(NOW - 120 * DAY);
    prunePaneNotes(d, NOW);
    ensurePaneNoteTable(d);
    expect(ids(d, "pane_note")).toEqual([]);
  });

  test("no legacy table is fine", () => {
    const d = fresh(false);
    expect(() => prunePaneNotes(d, NOW)).not.toThrow();
  });
});
