/*
 * Retention deletes rows; it does not give the disk back.
 *
 * SQLite keeps a deleted row's pages on a freelist and reuses them, which is
 * the right default for a database that grows back to its high-water mark. This
 * one does not: measured on a real cockpit, 62,706 of 116,162 pages were free
 * and a 476 MB file held 214 MB of data — 262 MB of disk that pruning had
 * already released and nothing was ever going to claim.
 *
 * What is asserted here is the guard, in both directions, because VACUUM
 * rewrites the whole file and running it on every boot would be churn rather
 * than housekeeping.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { db, dbPath, reclaimFreePages, trimWal, WAL_SIZE_LIMIT } from "../src/db.ts";

const pages = () => Number((db.query("PRAGMA page_count").get() as { page_count: number }).page_count);
const free = () => Number((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);

describe("reclaiming the pages retention freed", () => {
  test("does nothing to a database that is mostly in use", () => {
    // Made mostly-in-use here rather than assumed: `bun test` shares one
    // process and one database across every suite, so whatever ran before this
    // may well have left a freelist of its own.
    db.exec("VACUUM");
    expect(free() / Math.max(1, pages())).toBeLessThanOrEqual(0.3);
    // Nothing has been deleted since, so there is nothing to reclaim and no
    // rewrite to pay for.
    expect(reclaimFreePages()).toBeNull();
  });

  test("gives the file back when a third of it is free, and keeps the data", () => {
    db.run("CREATE TABLE IF NOT EXISTS reclaim_probe (id INTEGER PRIMARY KEY, blob TEXT)");
    db.run("DELETE FROM reclaim_probe");
    const wide = "x".repeat(4000);
    const insert = db.prepare("INSERT INTO reclaim_probe (id, blob) VALUES (?, ?)");
    db.transaction(() => { for (let i = 0; i < 4000; i++) insert.run(i, wide); })();
    // Keep a few, so "it shrank" and "it still has the rows" are both checkable.
    db.run("DELETE FROM reclaim_probe WHERE id >= 40");
    const before = pages();
    expect(free() / before).toBeGreaterThan(0.3);

    const r = reclaimFreePages();
    expect(r).not.toBeNull();
    expect(pages()).toBeLessThan(before);
    expect(Number((db.query("SELECT COUNT(*) c FROM reclaim_probe").get() as { c: number }).c)).toBe(40);
    expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");

    // The temp copy is written next to the database, not into /tmp — which on
    // the machine this was written for is a tmpfs at 94% full, i.e. RAM.
    expect(process.env.SQLITE_TMPDIR).toBeTruthy();
    expect(dbPath().startsWith(process.env.SQLITE_TMPDIR!)).toBe(true);

    db.run("DROP TABLE reclaim_probe");
  });
});

/*
 * The WAL file keeps the size of its largest run unless something shrinks it,
 * and VACUUM writes the whole database through it: measured at 933 MB beside a
 * 945 MB database, months after the vacuum that made it.
 */
describe("the WAL file gives its space back", () => {
  const walBytes = () => { try { return statSync(dbPath() + "-wal").size; } catch { return 0; } };

  test("is capped by journal_size_limit", () => {
    const r = db.query("PRAGMA journal_size_limit").get() as { journal_size_limit: number };
    expect(r.journal_size_limit).toBe(WAL_SIZE_LIMIT);
    expect(WAL_SIZE_LIMIT).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  test("is empty after a reclaim, not the size of what the vacuum wrote", () => {
    db.run("CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY, blob TEXT)");
    db.run("DELETE FROM wal_probe");
    const wide = "x".repeat(4000);
    const insert = db.prepare("INSERT INTO wal_probe (id, blob) VALUES (?, ?)");
    db.transaction(() => { for (let i = 0; i < 3000; i++) insert.run(i, wide); })();
    db.run("DELETE FROM wal_probe WHERE id >= 10");
    expect(walBytes()).toBeGreaterThan(1_000_000);

    expect(reclaimFreePages()).not.toBeNull();
    expect(walBytes()).toBe(0);
    expect(Number((db.query("SELECT COUNT(*) c FROM wal_probe").get() as { c: number }).c)).toBe(10);
    db.run("DROP TABLE wal_probe");
  });

  test("never waits for a reader in another connection", () => {
    db.run("DROP TABLE IF EXISTS wal_probe");
    db.run("CREATE TABLE wal_probe (id INTEGER PRIMARY KEY)");
    db.run("INSERT INTO wal_probe (id) VALUES (1)");
    const reader = new Database(dbPath(), { readonly: true });
    try {
      reader.exec("BEGIN");
      reader.query("SELECT COUNT(*) FROM wal_probe").get();
      // A write after the reader's snapshot keeps the WAL in use by it.
      db.run("INSERT INTO wal_probe (id) VALUES (2)");
      const r = trimWal();
      expect(r.busy).toBe(true);
      // busy_timeout is 5000 ms; anything near it is the event loop waiting.
      expect(r.ms).toBeLessThan(1000);
      // And the connection's own timeout is back for every other statement.
      expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    expect(trimWal().busy).toBe(false);
    expect(walBytes()).toBe(0);
    db.run("DROP TABLE wal_probe");
  });
});
