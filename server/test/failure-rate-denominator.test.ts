// A failure rate must divide tool failures by tool calls (#248 F6).
//
// `errors` was SUM(is_error) over every event, but the denominator everywhere
// is tool calls — and an errored event need not be a tool. The OTLP paths set
// is_error on "Turn complete", an LLM span that never enters tool_calls, and
// ingest.ts flags any event carrying a top-level `error`/`stderr` string. So a
// window with clean tools and errored spans read as failing:
//
//   health ring   1 - 3/10  → 70%, "Degraded", with zero tool failures
//   insights      6 errs / 4 tools → "High failure rate · 150%",
//                 and under it "6 of 4 tool calls failed"
//
// insights had no clamp at all, which is how the rate got above 100.
//
// The fix keeps both counts. `errors` still means "how much went wrong", which
// is what the Failed tile and the timeline series want; `tool_errors` is the
// one a tool-call denominator may be paired with.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-failrate-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "failrate.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let getInsights: typeof import("../src/insights.ts").getInsights;

const SESSION = "s-clean-tools";

const event = (type: string, isError: boolean, back: number) => ({
  source_app: "proj",
  session_id: SESSION,
  hook_event_type: type,
  tool_name: type.startsWith("PostToolUse") ? "Bash" : null,
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: isError ? 1 : 0,
  error_text: isError ? "boom" : null,
  usage: { input_tokens: 10, output_tokens: 10, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now() - back,
  payload: { project_path: ROOT },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  getInsights = (await import("../src/insights.ts")).getInsights;
  // Four tool calls, none of which failed.
  for (let i = 0; i < 4; i++) db.insertEvent(event("PostToolUse", false, 60_000 + i) as any);
  // Six errored LLM spans — the shape otlp.ts produces. More errors than there
  // are tool calls, which is what drove the rate past 100%.
  for (let i = 0; i < 6; i++) db.insertEvent(event("Turn complete", true, 50_000 + i) as any);
});

describe("the two error counts answer different questions", () => {
  test("errors still counts every errored event", () => {
    expect(db.statsSummary(3_600_000).totals.errors).toBe(6);
  });

  test("tool_errors counts only tool failures — here, none", () => {
    expect(db.statsSummary(3_600_000).totals.tool_errors).toBe(0);
  });

  test("tool_errors can never exceed tool_calls, which is the whole point", () => {
    const t = db.statsSummary(3_600_000).totals;
    expect(t.tool_errors!).toBeLessThanOrEqual(t.tool_calls);
  });
});

describe("insights does not report a failure rate for tools that did not fail", () => {
  test("no high-failure-rate card when every tool call succeeded", () => {
    const cards = getInsights().filter((i) => i.kind === "errors");
    expect(cards).toEqual([]);
  });

  test("a real tool failure still raises one, and its rate is bounded", () => {
    // Three of five tool calls fail — 60%, genuinely worth a card.
    // Short id on purpose: insights keys a card by `${app}:${sid.slice(0, 8)}`.
    const s2 = "s-real";
    const ev = (type: string, isError: boolean, back: number) => ({
      ...event(type, isError, back), session_id: s2,
    });
    for (let i = 0; i < 2; i++) db.insertEvent(ev("PostToolUse", false, 40_000 + i) as any);
    for (let i = 0; i < 3; i++) db.insertEvent(ev("PostToolUseFailure", true, 30_000 + i) as any);
    const card = getInsights().find((i) => i.kind === "errors" && (i.session ?? "").includes(s2));
    expect(card).toBeDefined();
    const pct = Number(card!.title.match(/(\d+)%/)![1]);
    expect(pct).toBe(60);
    expect(pct).toBeLessThanOrEqual(100);
    expect(card!.detail).toBe("3 of 5 tool calls failed");
  });
});
