/*
 * The two reads behind the shared-tree flag, against a real database.
 *
 * Both run on the server loop every time the Diff view's working list is
 * rebuilt — every two seconds while agents are editing, which is exactly when
 * the terminal sharing that thread is busiest. So what is pinned here is the
 * shape of the work as well as the answer: the query plan, and which rows get
 * their JSON parsed at all. Timings would be the direct measure, and on a
 * loaded machine they are also the flaky one.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTGLASS_DB = join(mkdtempSync(join(tmpdir(), "agx-shared-tree-db-")), "agentglass.db");

const { db, insertEvent } = await import("../src/db.ts");
const { normalize } = await import("../src/ingest.ts");
const { recentSessions } = await import("../src/sharedtree.ts");

const NOW = Date.now();
const ingest = (session_id: string, hook_event_type: string, timestamp: number, payload: Record<string, unknown> = {}) =>
  insertEvent(normalize({
    source_app: "orbit", session_id, hook_event_type, timestamp, payload,
  } as unknown as Parameters<typeof normalize>[0]));
const write = (session_id: string, file_path: string, timestamp: number) =>
  ingest(session_id, "PostToolUse", timestamp, { tool_name: "Write", tool_input: { file_path, content: "x" } });

/** Run `fn`, keeping every statement it prepares. */
function watching<T>(fn: () => T): { value: T; sql: string[] } {
  const real = db.query.bind(db);
  const sql: string[] = [];
  (db as unknown as { query: unknown }).query = (s: string) => { sql.push(s); return real(s); };
  try { return { value: fn(), sql }; } finally { (db as unknown as { query: unknown }).query = real; }
}
const plan = (sql: string) =>
  db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN " + sql).all().map((r) => r.detail).join(" | ");

describe("recentSessions", () => {
  test("a session whose last word is SessionEnd is gone; one that spoke after it is not", () => {
    write("s-ended", "/home/dev/code/orbit/a.ts", NOW - 3000);
    ingest("s-ended", "SessionEnd", NOW - 2000, { reason: "clear" });
    ingest("s-resumed", "SessionEnd", NOW - 3000);
    ingest("s-resumed", "UserPromptSubmit", NOW - 1000, { prompt: "go on" });
    write("s-busy", "/home/dev/code/orbit/b.ts", NOW - 1000);
    const by = new Map(recentSessions(NOW).map((r) => [r.session_id, r.gone]));
    expect(by.get("s-ended")).toBe(true);
    expect(by.get("s-resumed")).toBe(false);
    expect(by.get("s-busy")).toBe(false);
  });

  test("whether a session ended is looked up in an index, not sorted out of its whole history", () => {
    // The newest-event subquery sorted every event of every recent session:
    // 110 ms for twenty sessions of six thousand events each.
    const { sql } = watching(() => recentSessions(NOW));
    expect(sql).toHaveLength(1);
    const p = plan(sql[0]!);
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).toContain("idx_events_first_prompt");
  });
});
