// A scoped /stats query must restrict to its time window inside the index, not
// scan a project's whole history (#220).
//
// Scope filters `(project_path IN (...) OR cwd_path IN (...))` and always pairs
// it with `timestamp >= since`. With a bare project_path index the planner did a
// MULTI-INDEX OR that fetched every row that project ever produced and then
// filtered the window row by row — on a project with months of history that is
// the ~400ms synchronous /stats stall the idle PTY rides. Folding timestamp into
// the index lets the same OR bound the window inside the index. The shape is the
// fix, so this pins the plan: the query plan must reach the rows through the
// composite indexes with a timestamp bound.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-statsidx-"));
const SCOPED = join(dir, "scoped");
const OTHER = join(dir, "other");
mkdirSync(SCOPED, { recursive: true });
mkdirSync(OTHER, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "statsidx.db");
process.env.AGENTGLASS_ROOT = SCOPED;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const event = (project: string, session: string, tsBack: number) => ({
  source_app: project.split("/").pop()!,
  session_id: session,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now() - tsBack,
  payload: { project_path: project },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  // Three scoped events clearly inside a 1h window...
  for (let i = 0; i < 3; i++) db.insertEvent(event(SCOPED, `s-recent-${i}`, i * 60_000) as any);
  // ...and a long tail of scoped history clearly outside it, spread over weeks,
  // so a 1h window is a tiny slice — the case the composite index is for.
  for (let i = 0; i < 200; i++) db.insertEvent(event(SCOPED, `s-old-${i}`, 2 * 3_600_000 + i * 1_800_000) as any);
  // Another project, recent — excluded by scope, not by the window.
  for (let i = 0; i < 20; i++) db.insertEvent(event(OTHER, `o-${i}`, i * 60_000) as any);
});

describe("scoped stats queries stay inside the time window via the index", () => {
  test("the query plan reaches rows through (project_path, timestamp), bounding the window", () => {
    const since = Date.now() - 3_600_000; // 1h window over a wide history
    const { clause, args } = db.scopeClause();
    expect(clause).toContain("project_path IN"); // scope actually applied
    const sql = `SELECT COUNT(*) AS n FROM events WHERE timestamp >= ?${clause}`;
    const plan = db.db
      .query<{ detail: string }, any[]>("EXPLAIN QUERY PLAN " + sql)
      .all(since, ...args)
      .map((r) => r.detail)
      .join(" | ");
    // The composite indexes carry the timestamp, so the window is bounded in the
    // index rather than filtered per row.
    expect(plan).toContain("idx_events_project_ts");
    expect(plan).toContain("idx_events_cwd_ts");
    expect(plan).toContain("timestamp>"); // the window is part of the index seek
    // And it is not a bare full scan of the table.
    expect(plan).not.toContain("SCAN events\n");
  });

  test("the scoped result is still correct (index change never alters the answer)", () => {
    // Only the three recent scoped events land in a 1h window; the 200-event tail
    // is older and the other project is out of scope.
    const s = db.statsSummary(3_600_000) as any;
    expect(s.totals.events).toBe(3);
  });
});
