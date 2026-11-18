// Two costs on GET /agents/board, measured on fake data (see the comments in
// db.ts and lantern.ts): the last-hour pulse query must be an index range seek,
// and the per-path git maps must stop growing. Fixtures are invented.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-board-caps-"));
process.env.AGENTGLASS_DB = join(dir, "caps.db");
process.env.XDG_CONFIG_HOME = dir;
delete process.env.AGENTGLASS_ROOT;

test("the pulse query seeks (session_id, timestamp) instead of reading every event of a session", async () => {
  const { db } = await import("../src/db.ts");
  const plan = db.query(
    `EXPLAIN QUERY PLAN SELECT session_id, CAST((timestamp - $from) / $step AS INTEGER) AS bucket, COUNT(*) AS n
       FROM events WHERE timestamp >= $from AND session_id IN (SELECT value FROM json_each($ids))
      GROUP BY session_id, bucket`,
  ).all({ $from: 0, $step: 300_000, $ids: "[]" }).map((r: any) => String(r.detail)).join(" | ");
  expect(plan).toContain("idx_events_session_ts");
  expect(plan).toContain("timestamp>?");
});

test("a per-path map keeps at most MEMO_MAX entries and drops the oldest first", async () => {
  const { __remember, MEMO_MAX } = await import("../src/lantern.ts");
  const m = new Map<string, number>();
  for (let i = 0; i < MEMO_MAX + 50; i++) __remember(m, `/work/orbit/wt-${i}`, i);
  expect(m.size).toBe(MEMO_MAX);
  expect(m.has("/work/orbit/wt-0")).toBe(false);
  expect(m.has(`/work/orbit/wt-${MEMO_MAX + 49}`)).toBe(true);
  // Asked again, an entry moves to the newest end and outlives the next eviction.
  __remember(m, "/work/orbit/wt-100", -1);
  __remember(m, "/work/orbit/new", 1);
  expect(m.has("/work/orbit/wt-100")).toBe(true);
  expect(m.size).toBe(MEMO_MAX);
});
