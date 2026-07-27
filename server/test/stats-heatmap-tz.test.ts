// The heatmap belongs to the viewer's clock, not the server's (#248 F13).
//
// It bucketed with getDay()/getHours(), which read the server process's zone,
// while the timeline beside it buckets UTC epochs and is rendered in the
// browser's. So "Tue 14:00" on the grid and 14:00 on the timeline described
// different real hours whenever the two clocks differed — offset by the
// difference, with whole day columns moving when it crossed midnight.
//
// Not theoretical: remote access and the phone companion exist precisely so
// the viewer is not sitting at the server.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-heatmaptz-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "heat.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

// Monday 2026-07-27 23:30 UTC. In Tokyo that is Tuesday 08:30; in Los Angeles,
// Monday 16:30. One instant, three different cells.
const AT = Date.parse("2026-07-27T23:30:00Z");
const cell = (weekday: number, hour: number) => weekday * 24 + hour;

const event = () => ({
  source_app: "proj",
  session_id: "s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 10, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: AT,
  payload: { project_path: ROOT },
  chat: null,
});

// The window has to reach back past a fixed date, so it is generous.
const WINDOW = Date.now() - AT + 3_600_000;
const lit = (tz?: string) => {
  const h = db.statsSummary(WINDOW, undefined, tz).heatmap;
  return h.reduce<number[]>((acc, n, i) => (n > 0 ? [...acc, i] : acc), []);
};

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(event() as any);
});

describe("the heatmap buckets in the zone it is asked for", () => {
  test("Tokyo puts a 23:30Z Monday event in Tuesday 08:00", () => {
    expect(lit("Asia/Tokyo")).toEqual([cell(2, 8)]);
  });

  test("Los Angeles puts the same instant in Monday 16:00", () => {
    expect(lit("America/Los_Angeles")).toEqual([cell(1, 16)]);
  });

  test("UTC puts it in Monday 23:00", () => {
    expect(lit("UTC")).toEqual([cell(1, 23)]);
  });

  // The three above are the point: one event, three answers, none of them the
  // server's opinion.
  test("two zones an offset apart do not agree, which is why tz is in the key", () => {
    expect(lit("Asia/Tokyo")).not.toEqual(lit("America/Los_Angeles"));
  });

  test("an unknown zone falls back rather than throwing", () => {
    expect(() => lit("Mars/Olympus_Mons")).not.toThrow();
    expect(lit("Mars/Olympus_Mons").length).toBe(1);
  });

  test("no zone at all still works — the old behaviour, the server's clock", () => {
    expect(lit(undefined).length).toBe(1);
  });

  // A cache keyed without tz would serve Tokyo's grid to Los Angeles for the
  // whole TTL. Interleaved on purpose: the second call must not be a cache hit.
  test("one viewer's grid is never served to another zone", () => {
    const tokyo = lit("Asia/Tokyo");
    const la = lit("America/Los_Angeles");
    const tokyoAgain = lit("Asia/Tokyo");
    expect(tokyoAgain).toEqual(tokyo);
    expect(la).not.toEqual(tokyo);
  });
});
