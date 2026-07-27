// A PreToolUse can answer exactly one Post (#248 F7), and a percentile must
// say how many samples it has (#248 F4).
//
// Pairing was a bare SELECT ... LIMIT 1 with nothing marking the row, so:
//
//   • two concurrent calls to the same tool both measured against the newest
//     Pre, and one of the two real durations simply vanished;
//   • a Post that found no id match fell back to *any* earlier Pre for that
//     tool with no lower time bound, which is how an hour-long duration gets
//     into the percentiles for a call that took a second.
//
// And `calls` counted every Post while the percentiles were computed only over
// paired rows, so "200 calls · p95 5ms" could be five milliseconds measured
// twice, with nothing on the wire disclosing it.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pairing-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "pair.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const T0 = Date.now() - 10 * 60_000;

const ev = (over: Record<string, unknown>) => ({
  source_app: "proj",
  session_id: "s1",
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: T0,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

const durations = (tool: string) =>
  db.db
    .query<{ duration_ms: number | null }, [string]>(
      `SELECT duration_ms FROM events
       WHERE hook_event_type IN ('PostToolUse','PostToolUseFailure') AND tool_name = ?
       ORDER BY id`
    )
    .all(tool)
    .map((r) => r.duration_ms);

beforeAll(async () => {
  db = await import("../src/db.ts");
});

// statsSummary memoizes for a second, keyed by (window, provider, scope), so
// each read below uses its own window rather than racing that TTL.
let w = 3_600_000;
const stats = () => db.statsSummary(w++);

describe("a Pre is consumed by the Post it answers", () => {
  test("interleaved calls keep their own durations", () => {
    // Two calls open 1s apart and close 1s apart. Taking the newest Pre for
    // both Posts reported 1000ms twice and lost the 2000ms entirely.
    const t = "Interleaved";
    db.insertEvent(ev({ tool_name: t, timestamp: T0 }) as any);
    db.insertEvent(ev({ tool_name: t, timestamp: T0 + 1000 }) as any);
    db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + 2000 }) as any);
    db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + 3000 }) as any);
    // FIFO: first Post belongs to the first Pre.
    expect(durations(t)).toEqual([2000, 2000]);
  });

  test("a second Post for the same tool_use_id does not re-use the Pre", () => {
    const t = "Duplicated";
    db.insertEvent(ev({ tool_name: t, tool_use_id: "tu-1", timestamp: T0 }) as any);
    db.insertEvent(ev({ tool_name: t, tool_use_id: "tu-1", hook_event_type: "PostToolUse", timestamp: T0 + 3000 }) as any);
    // A retry, a duplicate delivery, a reused id — whatever the cause, that Pre
    // is spent. Nothing is invented for the second.
    db.insertEvent(ev({ tool_name: t, tool_use_id: "tu-1", hook_event_type: "PostToolUse", timestamp: T0 + 9000 }) as any);
    expect(durations(t)).toEqual([3000, null]);
  });

  test("an orphaned Post does not reach back through history", () => {
    // A Pre from 40 minutes ago, past the ceiling the open-tool card uses to
    // call a call lost. Pairing against it reported a 40-minute tool call.
    const t = "Orphan";
    db.insertEvent(ev({ tool_name: t, timestamp: T0 - 40 * 60_000 }) as any);
    db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 }) as any);
    expect(durations(t)).toEqual([null]);
  });

  test("the ordinary case still pairs", () => {
    const t = "Ordinary";
    db.insertEvent(ev({ tool_name: t, timestamp: T0 }) as any);
    db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + 250 }) as any);
    expect(durations(t)).toEqual([250]);
  });
});

describe("the percentiles declare their sample size", () => {
  test("timed counts paired calls, calls counts invocations", () => {
    const t = "Partial";
    // One measured call...
    db.insertEvent(ev({ tool_name: t, timestamp: T0 }) as any);
    db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + 500 }) as any);
    // ...and three Posts that arrived with no start at all, as an OTLP-logs
    // source or a hook payload without a tool_use_id does.
    for (let i = 0; i < 3; i++) {
      db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + 600 + i }) as any);
    }
    const row = stats().tool_latency.find((x) => x.tool_name === t)!;
    expect(row.calls).toBe(4);
    expect(row.timed).toBe(1);
    // The p95 is that single 500ms sample — true, but only because the row now
    // says what it rests on.
    expect(row.p95_ms).toBe(500);
  });

  test("a tool with no paired call at all reports a sample of zero", () => {
    const t = "Unmeasured";
    for (let i = 0; i < 5; i++) {
      db.insertEvent(ev({ tool_name: t, hook_event_type: "PostToolUse", timestamp: T0 + i }) as any);
    }
    const row = stats().tool_latency.find((x) => x.tool_name === t)!;
    expect(row.calls).toBe(5);
    expect(row.timed).toBe(0);
    // 0ms is what the panel used to render as a confident "instant"; the value
    // is still 0 on the wire, but `timed` is what lets the UI say "—" instead.
    expect(row.p50_ms).toBe(0);
  });

  test("timed never exceeds calls", () => {
    for (const row of stats().tool_latency) {
      expect(row.timed!).toBeLessThanOrEqual(row.calls);
    }
  });
});
