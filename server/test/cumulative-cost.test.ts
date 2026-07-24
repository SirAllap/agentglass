// Cumulative token cost must follow the model that produced each turn (#247).
//
// A cumulative (transcript-summed) event used to have its whole since-last-event
// token delta priced at ONE model — the current event's. A session that switched
// models mid-run (an Opus session that hands a turn to a Haiku subagent, and then
// the parent's next event carries the Haiku turn's tokens) billed that delta at
// the parent's rate. sumTranscriptCost prices each transcript message at its own
// message.model, and the DB charges the difference of those totals, so the switch
// is billed correctly.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sumTranscriptCost, normalize } from "../src/ingest.ts";
import { costUsd } from "../src/pricing.ts";

const OPUS = "claude-opus-4-8";
const HAIKU = "claude-haiku-4-5";
const opusUsage = { input_tokens: 1000, output_tokens: 200 };
const haikuUsage = { input_tokens: 5000, output_tokens: 400 };
const msg = (model: string, usage: Record<string, number>) => ({ message: { model, usage } });

describe("sumTranscriptCost prices each turn at its own model", () => {
  test("a two-model transcript sums the per-model costs", () => {
    const chat = [msg(OPUS, opusUsage), msg(HAIKU, haikuUsage)];
    const perModel = costUsd(opusUsage, OPUS) + costUsd(haikuUsage, HAIKU);
    expect(sumTranscriptCost(chat, null)).toBeCloseTo(perModel, 10);
  });

  test("that differs from pricing the summed tokens at a single model (the old bug)", () => {
    const chat = [msg(OPUS, opusUsage), msg(HAIKU, haikuUsage)];
    const wrong = costUsd({ input_tokens: 6000, output_tokens: 600 }, OPUS); // whole delta at Opus
    expect(sumTranscriptCost(chat, null)).not.toBeCloseTo(wrong, 6);
  });

  test("a line with usage but no model falls back to the event's model", () => {
    const chat = [{ message: { usage: opusUsage } }];
    expect(sumTranscriptCost(chat, HAIKU)).toBeCloseTo(costUsd(opusUsage, HAIKU), 10);
  });

  test("normalize fills cost_cumulative from the transcript, null when payload usage is present", () => {
    const chat = [msg(OPUS, opusUsage), msg(HAIKU, haikuUsage)];
    const cumulative = normalize({ session_id: "s", hook_event_type: "Stop", model_name: OPUS, chat } as any);
    expect(cumulative.usage_is_cumulative).toBe(true);
    expect(cumulative.cost_cumulative).toBeCloseTo(costUsd(opusUsage, OPUS) + costUsd(haikuUsage, HAIKU), 10);

    const perTurn = normalize({ session_id: "s", hook_event_type: "Stop", model_name: OPUS, payload: { usage: opusUsage } } as any);
    expect(perTurn.usage_is_cumulative).toBe(false);
    expect(perTurn.cost_cumulative).toBeNull();
  });
});

// --- DB path: a model switch across two cumulative events -------------------
const dir = mkdtempSync(join(tmpdir(), "agx-cumcost-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "cumcost.db");
process.env.AGENTGLASS_ROOT = PROJ;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
const ing = await import("../src/ingest.ts");

const body = (chat: unknown[]) => ({
  source_app: "app",
  session_id: "cc-session",
  hook_event_type: "Stop",
  model_name: OPUS, // the PARENT model on both events, even when a Haiku turn was added
  chat,
  payload: { project_path: PROJ },
  timestamp: Date.now(),
});

describe("insertEvent charges a mid-run model switch at the right rates", () => {
  beforeAll(async () => {
    db = await import("../src/db.ts");
    // Event 1: only the Opus turn so far.
    db.insertEvent(ing.normalize(body([msg(OPUS, opusUsage)]) as any));
    // Event 2: the transcript now also carries a Haiku subagent turn, but the
    // event itself is still tagged with the parent Opus model.
    db.insertEvent(ing.normalize(body([msg(OPUS, opusUsage), msg(HAIKU, haikuUsage)]) as any));
  });

  test("session cost is the per-model total, not the whole delta at the parent model", () => {
    const s = db.getSessions(100).find((r) => r.session_id === "cc-session")!;
    const right = costUsd(opusUsage, OPUS) + costUsd(haikuUsage, HAIKU);
    const wrong = costUsd(opusUsage, OPUS) + costUsd(haikuUsage, OPUS); // Haiku tokens at Opus rate
    expect(s.cost_usd).toBeCloseTo(right, 8);
    expect(s.cost_usd).not.toBeCloseTo(wrong, 6);
  });
});
