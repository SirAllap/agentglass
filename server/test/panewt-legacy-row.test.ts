/**
 * A pane note is also written where an older build reads it.
 *
 * This build keeps its notes in `pane_note`, keyed by pane AND tmux server,
 * and leaves `pane_agent` alone so an older build can still start on the same
 * file. Left alone, though, it froze: every note written after the upgrade
 * went only to the new table, so a downgrade read the pane as holding the
 * conversation it had before any `/clear` since — and the restore resumed
 * that one. The legacy row is now kept current too, in the only shape the
 * older build's upsert accepts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { ensurePaneNoteTable, notePaneAgent, paneAgentNote } from "../src/panewt.ts";

const REPO = "/home/dev/code/orbit";
const legacy = (pane: string) =>
  db.query<{ session_id: string; transcript_path: string }, [string]>(
    "SELECT session_id, transcript_path FROM pane_agent WHERE pane_id = ?").get(pane);

beforeEach(() => { db.exec("DROP TABLE IF EXISTS pane_agent"); });

describe("the legacy pane row", () => {
  test("follows a /clear in the shape the oldest reader has", () => {
    db.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
    notePaneAgent({ pane: "%9801", sessionId: "before-clear", transcriptPath: "/before.jsonl", cwd: REPO, at: 1000 });
    notePaneAgent({ pane: "%9801", sessionId: "after-clear", transcriptPath: "/after.jsonl", cwd: REPO, at: 2000 });
    expect(legacy("%9801")).toEqual({ session_id: "after-clear", transcript_path: "/after.jsonl" });
  });

  test("and in the one with the server column added", () => {
    db.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL, server TEXT NOT NULL DEFAULT '')`);
    notePaneAgent({ pane: "%9802", sessionId: "s2", transcriptPath: "/s2.jsonl", cwd: REPO, server: "/tmp/tmux-1000/orbit,4242" });
    expect(legacy("%9802")?.session_id).toBe("s2");
  });

  test("a table keyed by two columns is left alone, and the note is still kept", () => {
    db.exec(`CREATE TABLE pane_agent (pane_id TEXT NOT NULL, session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL, server TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (pane_id, server))`);
    expect(notePaneAgent({ pane: "%9803", sessionId: "s3", transcriptPath: "/s3.jsonl", cwd: REPO })).toBe(true);
    expect(paneAgentNote("%9803")?.session_id).toBe("s3");
    expect(legacy("%9803")).toBeNull();
  });

  test("no legacy table is created where there is none", () => {
    notePaneAgent({ pane: "%9804", sessionId: "s4", transcriptPath: "/s4.jsonl", cwd: REPO });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'pane_agent'").get()).toBeNull();
  });

  test("a restart does not bring another server's pane back through it", () => {
    /* The legacy row holds the newest hook from EITHER server. Copied back
       under "no server" at the next start, it would be read as this pane's —
       the mix-up the per-server key exists to end. */
    const A = "/tmp/tmux-1000/engine,4242", B = "/tmp/tmux-1000/default,777";
    // Both shapes: the oldest has no server column, so its row names none.
    for (const [pane, extra] of [["%9805", ""], ["%9807", ", server TEXT NOT NULL DEFAULT ''"]] as const) {
      db.exec("DROP TABLE IF EXISTS pane_agent");
      db.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL${extra})`);
      notePaneAgent({ pane, sessionId: "on-a", transcriptPath: "/a.jsonl", cwd: REPO, server: A, at: 1000 });
      notePaneAgent({ pane, sessionId: "on-b", transcriptPath: "/b.jsonl", cwd: REPO, server: B, at: 2000 });
      ensurePaneNoteTable(db);
      expect(paneAgentNote(pane, A)?.session_id, pane).toBe("on-a");
    }
  });

  test("but a row an older build wrote after the upgrade is still brought forward", () => {
    db.exec(`CREATE TABLE pane_agent (pane_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL, cwd TEXT NOT NULL, at INTEGER NOT NULL)`);
    notePaneAgent({ pane: "%9806", sessionId: "before-downgrade", transcriptPath: "/1.jsonl", cwd: REPO, at: 1000 });
    db.run("UPDATE pane_agent SET session_id = 'written-by-older', at = 3000 WHERE pane_id = '%9806'");
    ensurePaneNoteTable(db);
    expect(paneAgentNote("%9806")?.session_id).toBe("written-by-older");
  });
});
