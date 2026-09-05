/*
 * The understudy's four tables, pinned — because this file cannot be migrated.
 *
 * server/src/db.ts has no migration system. It versions itself with CREATE
 * TABLE IF NOT EXISTS and, for a column added after the fact, an ad-hoc
 * `try { ALTER TABLE … } catch {}`. That is enough for one nullable column and
 * nothing like enough for a rename, a changed default, or a UNIQUE constraint
 * added to a table that already has rows in it on somebody's machine. So the
 * shape has to be right the first time, and these tests are what "right" means:
 * every default the ledger relies on, the uniqueness that makes a future
 * re-ingest idempotent rather than duplicative, and the external-content FTS
 * index that has to be kept in step by hand because there is not one trigger
 * anywhere in server/src.
 *
 * The last test starts a second Bun process against the SAME database file.
 * That is the case a fresh temporary directory never exercises: opening a
 * database that already has these tables and these rows in it, which is what
 * every restart on a real machine does. It has to be a no-op, and it has to not
 * throw — a CREATE that only works on an empty file would break the app on its
 * second launch and pass here for ever.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agx-understudy-schema-"));
const dbPath = join(dir, "understudy.db");
process.env.AGENTGLASS_DB = dbPath;
process.env.XDG_CONFIG_HOME = dir;

let DB: typeof import("../src/db.ts");
beforeAll(async () => { DB = await import("../src/db.ts"); });

/**
 * The understudy objects of one kind, by name.
 *
 * fts5 creates four shadow tables of its own next to the virtual one
 * (_config, _data, _docsize, _idx) and an implicit index behind every UNIQUE
 * constraint. Neither is ours to assert on — they are the storage engine's
 * business and their names are not part of any contract — so they are filtered
 * out, and what is left is exactly what this file's DDL asked for.
 */
const objects = (type: string): string[] =>
  DB.db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
    .all(type)
    .map((r) => r.name)
    .filter((n) => /^(idx_)?understudy/.test(n) && !/_fts_(config|data|docsize|idx)$/.test(n))
    .sort();

describe("the tables a fresh database gets", () => {
  test("all eleven, plus the full-text index over the precedents", () => {
    // Enumerated rather than counted, and it earns that every time the list
    // changes: `understudy_proposals` arrived with the queue and this test is
    // where a new table has to be acknowledged out loud rather than appearing.
    expect(objects("table")).toEqual([
      "understudy_acts",
      /*
       * The work loop's two, and they are here because they stopped depending
       * on import order. Both were created by a db.run at module scope, so a
       * fresh database had them only once somebody had reached for the module
       * that made them — this test passed alone and failed in the full run,
       * which is the worst way for a defect to announce itself.
       */
      "understudy_asked",
      /* Where it raises its hand. Added because the measured failure was
         silence: 26 of 108 runs ended having delivered nothing and not one of
         them said what it needed. */
      "understudy_help",
      /* The one nap: until the agent's session limit resets. One row, ever. */
      "understudy_hold",
      "understudy_ledger",
      "understudy_precedents",
      "understudy_precedents_fts",
      "understudy_proposals",
      "understudy_quarantine",
      "understudy_shifts",
      "understudy_snapshots",
      "understudy_work",
    ]);
  });

  test("the three indexes the scorecard reads through", () => {
    // A scorecard query is per class over a window, and the panel also asks
    // "what happened to this pull request" — which is the third one. Without
    // them the ledger is a full scan on every frame, and the frame is pushed
    // on a timer.
    expect(objects("index")).toEqual([
      // "what did it do while I was out", which is the first thing anybody
      // opens after leaving it running.
      "idx_understudy_acts",
      "idx_understudy_class",
      // A machine clearing its own hand looks up by kind, never by title —
      // the give-up hands are filed under the user's own task title, which
      // this index has no business matching on.
      "idx_understudy_help_kind",
      // "what is it stuck on", read on every render of the work tab — and the
      // partial shape of it, open rows first, is the only query it serves.
      "idx_understudy_help_open",
      // The queue is read as "what is pending, newest first" on every render of
      // its tab, which is a scan without this.
      "idx_understudy_proposals",
      "idx_understudy_sealed",
      // "is a shift running", asked on every render of the queue tab.
      "idx_understudy_shifts",
      "idx_understudy_snap_at",
      "idx_understudy_subject",
      "idx_understudy_work",
    ]);
  });
});

describe("the defaults the ledger leans on", () => {
  test("a row written with only a kind and a seal is already complete", () => {
    // Everything a stub does not know has to have an answer, because the
    // scorecard counts over these columns and a NULL in `provenance` or `mode`
    // would drop the row out of a comparison rather than fail it loudly.
    DB.db.run("INSERT INTO understudy_ledger (kind, sealed_at) VALUES ('stub', 1000)");
    const row = DB.db.query<Record<string, unknown>, []>(
      "SELECT * FROM understudy_ledger WHERE sealed_at = 1000").get()!;
    expect(row).toMatchObject({
      kind: "stub", class: "", route: "", method: "", subject: "", repo: "",
      partition: "global", actor: "", provenance: "", situation_hash: "",
      late: 0, unsealed: 0, mode: "shadow", tokens: 0,
    });
    // …and everything that is genuinely unknown stays unknown. An unscored row
    // must not read as an agreement, which a default of '' would invite.
    expect(row.predicted).toBeNull();
    expect(row.predicted_at).toBeNull();
    expect(row.actual).toBeNull();
    expect(row.actual_at).toBeNull();
    expect(row.verdict).toBeNull();
    expect(row.status).toBeNull();
  });

  test("a snapshot is keyed by its hash, so the same seal cannot land twice", () => {
    DB.db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES ('deadbeef', 2000, '{}')");
    expect(() => DB.db.run(
      "INSERT INTO understudy_snapshots (hash, at, body) VALUES ('deadbeef', 3000, '{}')")).toThrow();
    const row = DB.db.query<{ at: number; partition: string }, []>(
      "SELECT at, partition FROM understudy_snapshots WHERE hash = 'deadbeef'").get()!;
    expect(row.at).toBe(2000);
    expect(row.partition).toBe("global");
  });

  test("the quarantine can say a refusal happened without saying what it was", () => {
    // The whole point of the table: a row here means "we refused to keep
    // something from this source", and there is nowhere in it to put the text
    // or the term that triggered it.
    DB.db.run("INSERT INTO understudy_quarantine (source_ref, class, at) VALUES ('orbit#1042', 'C11', 4000)");
    const cols = DB.db.query<{ name: string }, []>("PRAGMA table_info(understudy_quarantine)")
      .all().map((c) => c.name).sort();
    expect(cols).toEqual(["at", "class", "id", "source_ref", "term_index"]);
    expect(DB.db.query<{ term_index: number }, []>(
      "SELECT term_index FROM understudy_quarantine WHERE at = 4000").get()!.term_index).toBe(-1);
  });

  test("a precedent cannot be ingested twice from the same source", () => {
    // UNIQUE(source, source_ref, class) is the constraint that would be
    // genuinely painful to add later, and the one that makes a re-ingest safe
    // to run rather than a second copy of everything.
    const ins = () => DB.db.run(
      `INSERT INTO understudy_precedents (class, source, source_ref, situation, decision, at)
       VALUES ('C1', 'pr', 'orbit#1042', 'a branch was needed', 'worktree off main', 5000)`);
    ins();
    expect(ins).toThrow();
    // Same reference, different class, is a different precedent.
    expect(() => DB.db.run(
      `INSERT INTO understudy_precedents (class, source, source_ref, at)
       VALUES ('C2', 'pr', 'orbit#1042', 5000)`)).not.toThrow();
  });
});

describe("the full-text index", () => {
  test("takes a row by hand and matches it", () => {
    // External content plus no triggers means whatever writes the precedents
    // writes this beside it, exactly as recordEvent does for events_fts. This
    // is that write, and it is the only thing proving the virtual table was
    // declared against a content table that actually exists.
    const id = DB.db.query<{ id: number }, []>(
      "SELECT id FROM understudy_precedents WHERE source_ref = 'orbit#1042' AND class = 'C1'").get()!.id;
    DB.db.run(
      `INSERT INTO understudy_precedents_fts (rowid, class, repo, situation, decision, his_words, source_ref)
       VALUES (?, 'C1', 'orbit', 'a branch was needed', 'worktree off main', '', 'orbit#1042')`, [id]);
    const hit = DB.db.query<{ rowid: number }, [string]>(
      "SELECT rowid FROM understudy_precedents_fts WHERE understudy_precedents_fts MATCH ?").get("worktree");
    expect(hit?.rowid).toBe(id);
  });
});

describe("opening a database that already has all of this in it", () => {
  /*
   * Two separate Bun processes against one file, rather than a second import in
   * this one, and for two reasons.
   *
   * The honest one: `bun test` runs every file in a single process with one
   * module registry, so a second `await import("../src/db.ts")` here returns the
   * instance some earlier test file already opened — against ITS database, not
   * this one. A no-op test that quietly measured the wrong file would pass for
   * ever and mean nothing.
   *
   * The one that matters anyway: what has to work is a restart. The first
   * process creates the tables on an empty file and writes rows; the second
   * opens a file that already has all of it and must add nothing, drop nothing
   * and throw nothing. That is every launch after the first on a real machine,
   * and it is the case a fresh temporary directory can never reach.
   */
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
  const restartPath = join(dir, "restart.db");
  const boot = (body: string) => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      process.env.AGENTGLASS_DB = ${JSON.stringify(restartPath)};
      process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
      const { db } = await import(${JSON.stringify(moduleUrl)});
      ${body}
      db.close();
    `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return child.stdout.toString();
  };

  test("a second boot keeps every row and adds no table", () => {
    boot(`
      db.run("INSERT INTO understudy_ledger (kind, class, sealed_at) VALUES ('decision', 'C1', 10)");
      db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES ('cafe', 10, '{}')");
      db.run("INSERT INTO understudy_quarantine (source_ref, at) VALUES ('orbit#1042', 10)");
      db.run("INSERT INTO understudy_precedents (class, source, source_ref, decision, at) VALUES ('C1', 'pr', 'orbit#1042', 'worktree off main', 10)");
      db.run("INSERT INTO understudy_precedents_fts (rowid, class, decision) VALUES (last_insert_rowid(), 'C1', 'worktree off main')");
    `);

    const out = JSON.parse(boot(`
      const n = (sql) => db.query(sql).get().n;
      process.stdout.write(JSON.stringify({
        ledger: n("SELECT COUNT(*) AS n FROM understudy_ledger"),
        snapshots: n("SELECT COUNT(*) AS n FROM understudy_snapshots"),
        quarantine: n("SELECT COUNT(*) AS n FROM understudy_quarantine"),
        precedents: n("SELECT COUNT(*) AS n FROM understudy_precedents"),
        // COUNT(*) on an external-content table scans the CONTENT table and
        // would answer 1 whether or not fts5 stored anything. A MATCH is the
        // only count that reads what the index actually holds.
        matched: n("SELECT COUNT(*) AS n FROM understudy_precedents_fts WHERE understudy_precedents_fts MATCH 'worktree'"),
        tables: db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'understudy%'").get().n,
      }));
    `));

    expect(out).toEqual({
      ledger: 1, snapshots: 1, quarantine: 1, precedents: 1, matched: 1,
      // Five declared, plus the four shadow tables fts5 keeps for itself.
      tables: 16,
    });
  });
});
