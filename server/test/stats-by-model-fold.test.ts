// "Where the money goes" must have one row per model, not one per raw id (#248 F5).
//
// The SQL groups by `model_name` — the raw id the source reported — and the
// display label is applied afterwards. Two ids that share a label therefore
// arrived as two separate rows reading the same name: an Opus session split
// across "claude-opus-4-1" and "claude-opus-4-5" rendered as two "Opus" slices,
// each carrying part of the spend, in the same hash-derived colour, with no
// single row stating what Opus actually cost. The donut's centre total was
// right, which is what kept it hidden.
//
// `sessions` is the column that cannot simply be summed: it is a
// COUNT(DISTINCT session_id) per raw id, so a session that switched model
// version mid-run appears in both rows and would be counted twice by the fold.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-bymodel-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
// Own repo: a TMPDIR under the checkout would widen this scope to the whole repo.
spawnSync("git", ["init", "-q", ROOT]);
process.env.AGENTGLASS_DB = join(dir, "bymodel.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const event = (model: string, session: string, tokens: number) => ({
  source_app: "proj",
  session_id: session,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: model,
  is_error: 0,
  error_text: null,
  usage: { input_tokens: tokens, output_tokens: tokens, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now() - 60_000,
  payload: { project_path: ROOT },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  // Two Opus point releases, and one session that used both — the case that
  // makes summing `sessions` wrong.
  db.insertEvent(event("claude-opus-4-1", "s-both", 1000) as any);
  db.insertEvent(event("claude-opus-4-5", "s-both", 2000) as any);
  db.insertEvent(event("claude-opus-4-5", "s-only-45", 3000) as any);
  // A different model, so the fold has something to keep apart.
  db.insertEvent(event("claude-haiku-4-5", "s-haiku", 500) as any);
  // #248 F21 residual: OpenAI 5.x ids that used to all display as "GPT-5"
  // must stay on separate slices when their PRICE_TABLE rates differ.
  db.insertEvent(event("gpt-5", "s-gpt5", 100) as any);
  db.insertEvent(event("gpt-5.4", "s-gpt54", 100) as any);
  db.insertEvent(event("gpt-5.5", "s-gpt55", 100) as any);
  db.insertEvent(event("gpt-5.6-luna", "s-luna", 100) as any);
  db.insertEvent(event("gpt-5.6-terra", "s-terra", 100) as any);
  db.insertEvent(event("gpt-5.6-sol", "s-sol", 100) as any);
});

const byLabel = (s: any, label: string) => s.by_model.filter((m: any) => m.model_name === label);

describe("by_model folds raw ids into one row per label", () => {
  test("two Opus point releases are one Opus row", () => {
    const opus = byLabel(db.statsSummary(3_600_000), "Opus");
    expect(opus.length).toBe(1);
  });

  test("that row carries the whole family's tokens, not a slice", () => {
    const [opus] = byLabel(db.statsSummary(3_600_000), "Opus");
    expect(opus.input_tokens).toBe(6000); // 1000 + 2000 + 3000
    expect(opus.output_tokens).toBe(6000);
  });

  test("a session that used both versions counts once, not twice", () => {
    const [opus] = byLabel(db.statsSummary(3_600_000), "Opus");
    // s-both and s-only-45. Summing the per-id COUNT(DISTINCT) would give 3.
    expect(opus.sessions).toBe(2);
  });

  test("a different model keeps its own row", () => {
    const s = db.statsSummary(3_600_000);
    expect(byLabel(s, "Haiku").length).toBe(1);
    expect(byLabel(s, "Haiku")[0].input_tokens).toBe(500);
  });

  test("the fold preserves the total — the donut's centre still reconciles", () => {
    const s = db.statsSummary(3_600_000);
    const summed = s.by_model.reduce((n: number, m: any) => n + m.input_tokens + m.output_tokens, 0);
    expect(summed).toBe(s.totals.input_tokens + s.totals.output_tokens);
  });

  // The panel renders the array in the order it arrives and the query has no
  // ORDER BY, so without an explicit sort the slices reshuffle between refreshes.
  test("rows arrive in a deterministic order, dearest first", () => {
    const costs = db.statsSummary(3_600_000).by_model.map((m: any) => m.cost_usd);
    expect([...costs].sort((a: number, b: number) => b - a)).toEqual(costs);
  });

  test("OpenAI 5.x rate tiers do not collapse into one GPT-5 slice", () => {
    const s = db.statsSummary(3_600_000);
    const labels = [
      "GPT-5", "GPT-5.4", "GPT-5.5",
      "GPT-5.6 Luna", "GPT-5.6 Terra", "GPT-5.6 Sol",
    ];
    for (const label of labels) {
      expect(byLabel(s, label).length, `${label} missing or duplicated`).toBe(1);
    }
    // Plain GPT-5 must not have swallowed the others.
    expect(byLabel(s, "GPT-5")[0].input_tokens).toBe(100);
  });
});
