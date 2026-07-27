// A cost the table could not price must say so.
//
// costUsd() falls back to DEFAULT_PRICE — Sonnet-tier $3/$15 per MTok — for any
// model it does not recognise, and returns that number with exactly the same
// confidence as a real one. Nothing downstream could tell the two apart, so a
// model the table has never heard of produced a spend figure that looked
// measured.
//
// That is not hypothetical maintenance: model names change every few months,
// and the file's own header says to re-verify the rates against each provider.
// A rename is all it takes for a whole vendor's spend to become a guess
// rendered as a fact.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-unpriced-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "unpriced.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let hasPrice: typeof import("../src/pricing.ts").hasPrice;

const event = (model: string, session: string) => ({
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
  usage: { input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: Date.now() - 60_000,
  payload: { project_path: ROOT },
  chat: null,
});

let w = 3_600_000;
const row = (label: string) =>
  db.statsSummary(w++).by_model.find((m) => m.model_name === label);

beforeAll(async () => {
  db = await import("../src/db.ts");
  hasPrice = (await import("../src/pricing.ts")).hasPrice;
  db.insertEvent(event("claude-opus-4-8", "s-known") as any);
  db.insertEvent(event("brand-new-model-9000", "s-unknown") as any);
});

describe("hasPrice answers the checkable question", () => {
  test("a model in the table has a rate", () => {
    expect(hasPrice("claude-opus-4-8")).toBe(true);
    expect(hasPrice("gpt-4.1")).toBe(true);
  });

  test("one that is not, does not", () => {
    expect(hasPrice("brand-new-model-9000")).toBe(false);
  });

  test("nothing at all is not a priced model either", () => {
    expect(hasPrice(null)).toBe(false);
    expect(hasPrice("")).toBe(false);
  });

  // The distinction that keeps this honest: it asks whether a RATE exists, not
  // whether the displayed cost was estimated. A source reporting its own exact
  // cost bypasses the table, and that is a different question.
  test("it is about the table, not about how a cost happened to be obtained", () => {
    expect(hasPrice("brand-new-model-9000")).toBe(false);
  });
});

describe("the spend panel marks what it could not price", () => {
  test("a known model is not marked", () => {
    expect(row("Opus")!.unpriced).toBe(false);
  });

  test("an unknown one is", () => {
    expect(row("brand-new-model-9000")!.unpriced).toBe(true);
  });

  test("it still gets a cost — the fallback, not zero", () => {
    // 1M in + 0.5M out at the $3/$15 fallback. The number is not wrong so much
    // as unfounded, which is exactly why it needs a mark rather than removal.
    expect(row("brand-new-model-9000")!.cost_usd).toBeGreaterThan(0);
  });

  // Both the label table and the price table match on substrings, so a future
  // release of a known family inherits its family's name and its family's rate.
  // Deliberate, and worth pinning: pricing a claude-opus-9 at Opus rates is a
  // far better guess than dropping it to the $3/$15 fallback, and the row is
  // correctly NOT marked, because a rate really does exist for it.
  //
  // The corollary is what makes the mark useful — it fires for a genuinely new
  // vendor or a renamed family, which is the case that costs money silently.
  test("a future version of a known family keeps its rate and is not marked", () => {
    db.insertEvent(event("claude-opus-9-9", "s-future") as any);
    const opus = row("Opus")!;
    expect(opus.unpriced).toBe(false);
    // ...and it folded into that row rather than making one of its own.
    expect(opus.sessions).toBeGreaterThan(1);
  });
});
