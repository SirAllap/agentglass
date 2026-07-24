// Every event counted in the window must appear in exactly one timeline bucket
// — sum(bucket events) == totals.events (#248). The 60 buckets are aligned down
// from `since` (start = floor(since/bucketMs)*bucketMs <= since), so they end at
// start + 60*bucketMs, which is <= now: the most recent up-to-(windowMs/60) of
// events fell into no bucket and vanished from the chart while still counting in
// the totals. An event at exactly `now` is always outside the aligned buckets,
// so it is the sharp case.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-timeline-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "timeline.db");
process.env.AGENTGLASS_ROOT = PROJ; // scope to this test's project so counts are exact under bun's shared DB
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const now = Date.now();
const event = (session: string, tsBack: number) => ({
  source_app: "app",
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
  summary: "",
  timestamp: now - tsBack,
  payload: { project_path: PROJ },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(event("s-newest", 0) as any); // at ~now — the dropped case
  db.insertEvent(event("s-mid", 30 * 60_000) as any); // mid-window
  db.insertEvent(event("s-old", 59 * 60_000) as any); // near the window start
});

describe("the timeline accounts for every event in the window", () => {
  test("sum of bucket events equals totals.events (nothing falls off the newest edge)", () => {
    const s = db.statsSummary(60 * 60_000) as any; // 1h window
    const tlSum = s.timeline.reduce((n: number, b: any) => n + b.events, 0);
    expect(s.totals.events).toBe(3);
    expect(tlSum).toBe(s.totals.events); // fails on pre-fix code: the ~now event has no bucket
  });
});
