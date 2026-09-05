/*
 * The scoped stats summary reads its filter out of the index.
 *
 * `project_path` and `cwd_path` are VIRTUAL columns — `json_extract` over the
 * payload, recomputed for every row that touches them. A scoped /stats
 * therefore paid a JSON parse twice per row for a filter an index could have
 * carried. Indexing the generated columns materialises them, which is the whole
 * point of doing it.
 *
 * Measured on a real 476 MB cockpit scoped to one project: the summary went
 * 158.9 → 137.5 ms over 24 hours and 394.0 → 301.4 ms over all of history. Both
 * are synchronous blocks on the thread the terminal rides, which is why a 13%
 * saving on a dashboard query is worth an index at all. The file grew by
 * nothing — it went into the freelist retention had already left.
 *
 * What is pinned here is the pair of facts a later edit could quietly undo: the
 * wide index exists, and the narrow one it replaced does not. Measured, with
 * both present the planner still took the narrow one, so keeping the old one
 * "just in case" would hand the whole saving back.
 */
import { describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";

const indexes = () =>
  db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);

describe("the by-type stats index", () => {
  test("carries the scope columns", () => {
    expect(indexes()).toContain("idx_events_type_cov_scoped");
    const cols = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?)")
      .all("idx_events_type_cov_scoped")
      .map((r) => r.name);
    expect(cols).toContain("project_path");
    expect(cols).toContain("cwd_path");
    expect(cols[0]).toBe("hook_event_type"); // still leads the GROUP BY
  });

  test("the narrow index it replaced is gone", () => {
    expect(indexes()).not.toContain("idx_events_type_cov");
  });

  test("is renamed rather than rebuilt, so a launch does not pay for it", async () => {
    // The index block runs at every module load. A DROP+CREATE under the SAME
    // name would rebuild the index on every launch, for ever — 100+ ms of boot
    // that nobody would ever see in a profile of the running server. Under a
    // new name both statements are no-ops from the second launch on.
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    expect(src).toContain('DROP INDEX IF EXISTS idx_events_type_cov"');
    expect(src).toContain("CREATE INDEX IF NOT EXISTS idx_events_type_cov_scoped");
  });
});
