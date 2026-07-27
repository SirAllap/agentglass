// The numbers must outlive the rows they came from (#292).
//
// Raw events are deleted at AGENTGLASS_RETENTION_DAYS — right for rows
// carrying prompts and command lines, and it silently capped every question
// worth asking. You could not see what a project cost last month, compare this
// sprint against the last, or set a budget that was not really a weekly one
// wearing a monthly label. The only escape was raising retention and paying
// for it in database size and query time.
//
// So expiring events are folded into a day-grained summary before the DELETE,
// in the same transaction — either both happened or neither did.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-rollup-"));
const ROOT = join(dir, "proj");
const OTHER = join(dir, "other");
for (const d of [ROOT, OTHER]) mkdirSync(d, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "rollup.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
const DAY = 86_400_000;

const event = (over: Record<string, unknown> = {}) => ({
  source_app: "proj",
  session_id: "s-old",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 100, output_tokens: 40, cache_creation_tokens: 0, cache_read_tokens: 10 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now() - 30 * DAY,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

const rawCount = () =>
  db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;

beforeAll(async () => {
  db = await import("../src/db.ts");
  // Thirty days ago: well past the 8-day default, so the prune takes it.
  for (let i = 0; i < 4; i++) db.insertEvent(event({ timestamp: Date.now() - 30 * DAY + i }) as any);
  // One errored tool call the same day, so the fold has something to separate.
  db.insertEvent(event({ timestamp: Date.now() - 30 * DAY + 5, hook_event_type: "PostToolUseFailure", is_error: 1 }) as any);
  // Another project, same day — must not leak into a scoped read.
  db.insertEvent(event({ timestamp: Date.now() - 30 * DAY + 6, session_id: "s-other", payload: { project_path: OTHER } }) as any);
  // And something recent, which the prune must leave alone entirely.
  db.insertEvent(event({ timestamp: Date.now() - 60_000, session_id: "s-live" }) as any);
});

describe("expiring events are summarised before they are deleted", () => {
  test("the raw rows really do go", () => {
    const before = rawCount();
    const { events, rolled } = db.pruneOldRows();
    expect(events).toBeGreaterThan(0);
    expect(rolled).toBeGreaterThan(0);
    expect(rawCount()).toBeLessThan(before);
  });

  test("but the day's totals survive them", () => {
    const days = db.rollupDays();
    expect(days.length).toBe(1);
    const d = days[0];
    // 5 scoped events on that day: 4 clean tool calls + 1 failure.
    expect(d.events).toBe(5);
    expect(d.tool_calls).toBe(5);
    expect(d.tool_errors).toBe(1);
    expect(d.input_tokens).toBe(500);
    expect(d.output_tokens).toBe(200);
    expect(d.cache_read_tokens).toBe(50);
    expect(d.sessions).toBe(1);
  });

  test("the live window is untouched", () => {
    // s-live is a minute old; the prune must not have taken it.
    const n = db.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE session_id = 's-live'")
      .get()!.n;
    expect(n).toBe(1);
  });

  test("the rollup is scoped like every other metric", () => {
    // The other project's event was folded too, but a scoped read must not
    // see it — the same rule the events queries follow.
    const scoped = db.rollupDays()[0];
    expect(scoped.sessions).toBe(1); // s-old only, not s-other
  });

  test("it can say how far back it goes, so a panel need not imply it has everything", () => {
    expect(db.rollupEarliestDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("folding twice does not double-count", () => {
  test("a second prune adds nothing, because the rows it would fold are gone", () => {
    const before = db.rollupDays()[0].events;
    db.pruneOldRows();
    expect(db.rollupDays()[0].events).toBe(before);
  });

  test("a later day accumulates onto the same row rather than replacing it", () => {
    // Another event on the SAME day, arriving late (a backfill, a replayed
    // export) and then expiring: its numbers must add to the day, not
    // overwrite it.
    const day30 = Date.now() - 30 * DAY + 7;
    db.insertEvent(event({ timestamp: day30, session_id: "s-old" }) as any);
    const before = db.rollupDays()[0];
    db.pruneOldRows();
    const after = db.rollupDays()[0];
    expect(after.events).toBe(before.events + 1);
    expect(after.input_tokens).toBe(before.input_tokens + 100);
  });
});
