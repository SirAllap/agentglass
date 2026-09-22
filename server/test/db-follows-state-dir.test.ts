/*
 * A PROBE THAT WROTE TO THE REAL HISTORY.
 *
 * `AGENTGLASS_STATE_DIR` is how a second server says "my state lives over
 * here" — the tmux socket, the panes and the task file all honour it. The
 * database did not, so a probe with a scratch state directory opened the real
 * one anyway.
 *
 * Measured 2026-08-27: a probe started at 22:19 the previous night was still
 * running eighteen hours later against this machine's database, with that
 * day's code. Its watchdog stopped the deputy's shifts with a reason that no
 * longer exists in the source and closed the rows of runs that were alive,
 * while the app itself was fixed and reinstalled four times. Nobody was
 * looking at that process; the afternoon read as "the deputy does not work".
 *
 * Driven as a child process, because the path is decided once at module load
 * and this suite has already loaded it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbNotice } from "../../shared/types.ts";

const ASK = `${JSON.stringify(new URL("../src/db.ts", import.meta.url).pathname)}`;
/** Ask a fresh process where its database is. NODE_ENV is cleared: under
 *  `bun test` every path answers "a scratch file", which would pass whatever
 *  this module did. */
async function dbPathWith(env: Record<string, string>, cwd?: string): Promise<string> {
  return (await dbPathAndWarning(env, cwd)).path;
}
async function dbPathAndWarning(env: Record<string, string>, cwd?: string): Promise<{ path: string; err: string; notice: DbNotice }> {
  const p = Bun.spawn(["bun", "-e", `const m = await import(${ASK}); console.log(JSON.stringify(m.dbNotice())); console.log(m.dbPath());`], {
    env: { ...process.env, NODE_ENV: "", ...env },
    cwd,
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const lines = out.trim().split("\n");
  return { path: lines.pop() ?? "", notice: JSON.parse(lines.pop() || "null"), err };
}

/** A database with one row in it, left in WAL mode with the row still in the
 *  -wal file: the shape a server that was killed rather than stopped leaves
 *  behind, and the one a copy of the main file alone would lose. */
const held: Database[] = [];
afterAll(() => { for (const db of held) db.close(); });
function historyAt(path: string, marker: string): void {
  const db = new Database(path, { create: true });
  // Held until the suite ends: a collected handle is closed, and closing the
  // last one checkpoints the -wal into the main file mid-test.
  held.push(db);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA wal_autocheckpoint=0");
  db.run("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  db.run("INSERT INTO t VALUES (?)", [marker]);
}
function rowsOf(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT v FROM t").all() as { v: string }[]).map((r) => r.v); } finally { db.close(); }
}

describe("where a second server puts its database", () => {
  test("a state directory of its own owns the database too", async () => {
    const state = mkdtempSync(join(tmpdir(), "agx-state-"));
    const where = await dbPathWith({ AGENTGLASS_STATE_DIR: state, AGENTGLASS_DB: "" });
    expect(where, "a probe with its own state directory opened the real history").toBe(join(state, "agentglass.db"));
    expect(existsSync(where)).toBe(true);
  });

  test("an explicit AGENTGLASS_DB still wins — naming a file is the stronger statement", async () => {
    const state = mkdtempSync(join(tmpdir(), "agx-state-"));
    const asked = join(mkdtempSync(join(tmpdir(), "agx-asked-")), "mine.db");
    const where = await dbPathWith({ AGENTGLASS_STATE_DIR: state, AGENTGLASS_DB: asked });
    expect(where).toBe(asked);
  });

  /*
   * A database file in the working directory used to win over the data dir.
   * A server started from `server/` in a checkout that once had a local
   * `agentglass.db` then read a months-old history and said nothing: the
   * sessions on screen were real, just not current. The data dir is the one
   * answer now. When it has a database of its own, the stray file is never
   * opened, and it is named both on stderr and to the app, which is where
   * somebody is looking.
   */
  test("a stray agentglass.db in the working directory does not shadow the data dir", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const stray = join(cwd, "agentglass.db");
    historyAt(stray, "stale");
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const current = join(data, "agentglass", "agentglass.db");
    mkdirSync(join(data, "agentglass"));
    historyAt(current, "current");
    const { path, err, notice } = await dbPathAndWarning(
      { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" }, cwd,
    );
    expect(path, "the stray file in the cwd shadowed the data dir").toBe(current);
    expect(rowsOf(current)).toEqual(["current"]);
    expect(err).toContain(stray);
    expect(err).toContain(current);
    expect(err.split("[db] ignoring").length - 1, "the warning is said once, not per open").toBe(1);
    expect(notice, "two databases and nothing for the app to show").toEqual({ kind: "ignored", stray, db: current });
  });

  /*
   * Before the data dir won, a checkout run from source kept its whole
   * history in that file — hook-only rows included (gate decisions, notes,
   * the activity log) that no transcript rescan brings back. Starting it
   * against an empty data dir would show an empty dashboard. So when the
   * data dir has nothing yet, the stray file is copied there once; the
   * original stays where it was, byte for byte.
   */
  test("with no database in the data dir yet, the stray one is copied there once and left alone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const stray = join(cwd, "agentglass.db");
    historyAt(stray, "orbit-history");
    const before = { main: readFileSync(stray), wal: readFileSync(stray + "-wal") };
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const current = join(data, "agentglass", "agentglass.db");
    const env = { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" };

    const first = await dbPathAndWarning(env, cwd);
    expect(first.path).toBe(current);
    expect(rowsOf(current), "the copy lost the rows still in the -wal file").toEqual(["orbit-history"]);
    expect(first.notice).toEqual({ kind: "copied", stray, db: current });
    expect(first.err).toContain(stray);
    expect(first.err).toContain(current);
    expect(existsSync(stray), "the original was removed").toBe(true);
    expect(readFileSync(stray).equals(before.main), "the original was modified").toBe(true);
    expect(readFileSync(stray + "-wal").equals(before.wal), "the original's -wal was modified").toBe(true);
    expect(statSync(current).mode & 0o077, "the copy is readable by others").toBe(0);

    // Once: the next start opens the copy and does not copy again, and a
    // file it already copied is not reported as a second database.
    const second = await dbPathAndWarning(env, cwd);
    expect(second.path).toBe(current);
    expect(second.notice).toBeNull();
    expect(second.err).not.toContain(stray);
  });

  test("a stray file that is not a database is not copied over an empty data dir", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const stray = join(cwd, "agentglass.db");
    writeFileSync(stray, "not a database, just a file with that name");
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const current = join(data, "agentglass", "agentglass.db");
    const { path, notice } = await dbPathAndWarning(
      { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" }, cwd,
    );
    expect(path).toBe(current);
    expect(notice).toEqual({ kind: "ignored", stray, db: current });
    expect(readFileSync(stray, "utf8")).toBe("not a database, just a file with that name");
  });

  test("no stray file, no warning", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agx-cwd-"));
    const data = mkdtempSync(join(tmpdir(), "agx-data-"));
    const { path, err, notice } = await dbPathAndWarning(
      { XDG_DATA_HOME: data, AGENTGLASS_DB: "", AGENTGLASS_STATE_DIR: "" }, cwd,
    );
    expect(path).toBe(join(data, "agentglass", "agentglass.db"));
    expect(err).not.toContain("agentglass.db");
    expect(notice).toBeNull();
  });
});
