// Index audit guard: the hot queries on `events` must each use an index, never a plain table scan.
// idx_events_session stays on purpose (db-stats-index.test.ts pins it: INDEXED BY in db.ts).
// "SCAN events USING COVERING INDEX" is an index walk and allowed; bare "SCAN events" is the table.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-idxplan-"));
mkdirSync(join(dir, "proj"), { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "plans.db");
process.env.AGENTGLASS_ROOT = join(dir, "proj");
process.env.XDG_CONFIG_HOME = dir;

const { db, riskReadSql } = await import("../src/db.ts");

const plan = (sql: string, n = 0): string =>
  db.query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(1)).map((r) => r.detail).join("\n");

const QUERIES: Record<string, [string, number]> = {
  "stats totals": ["SELECT COUNT(*), SUM(cost_usd), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), COUNT(DISTINCT session_id), SUM(is_error) FROM events WHERE timestamp >= ?", 1],
  "stats by model": ["SELECT model_name, COUNT(DISTINCT session_id), SUM(cost_usd), SUM(input_tokens), SUM(output_tokens) FROM events WHERE timestamp >= ? GROUP BY model_name", 1],
  "stats by app": ["SELECT source_app, COUNT(DISTINCT session_id), SUM(cost_usd) FROM events WHERE timestamp >= ? GROUP BY source_app", 1],
  "stats by type": ["SELECT hook_event_type, COUNT(*) FROM events WHERE timestamp >= ? GROUP BY hook_event_type", 1],
  "first prompt": ["SELECT session_id, substr(payload, 1, 400), MIN(timestamp) FROM events WHERE hook_event_type = 'UserPromptSubmit' AND session_id IN (?,?) GROUP BY session_id", 2],
  "pre-open": [riskReadSql(2), 4],
  "session lookup": ["SELECT 1 FROM events WHERE session_id = ? LIMIT 1", 1],
  "session last hour": ["SELECT COUNT(*) FROM events WHERE session_id = ? AND timestamp >= ?", 2],
  "sessions by provider": ["SELECT session_id FROM events WHERE provider = ?", 1],
  "newest events": ["SELECT * FROM events ORDER BY timestamp DESC, id DESC LIMIT 50", 0],
};

describe("events query plans", () => {
  for (const [name, [sql, n]] of Object.entries(QUERIES)) {
    test(`${name}: no table scan`, () => {
      const p = plan(sql, n);
      expect(p).toContain("events");
      expect(/SCAN events(?! USING)/.test(p)).toBe(false);
    });
  }
  test("idx_events_session and session_ts both remain", () => {
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all().map((r) => r.name);
    expect(names).toContain("idx_events_session");
    expect(names).toContain("idx_events_session_ts");
  });
});
