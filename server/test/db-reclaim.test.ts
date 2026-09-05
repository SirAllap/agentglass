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
import { db, dbPath, reclaimFreePages } from "../src/db.ts";

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
