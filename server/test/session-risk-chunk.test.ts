// The first warm turn after a boot read 5 sessions in one go; two of them hold
// 3,446 and 1,203 edits and take 496 ms and 327 ms cold on the live DB copy. A turn is
// now bounded by a span of event ids (RISK_WARM_SPAN), and a session with more edits than
// one span holds is read a span per turn, the watermark moving by span.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-riskchunk-"));
const ROOT = join(dir, "orbit");
mkdirSync(ROOT, { recursive: true });
const saved = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
process.env.AGENTGLASS_DB = join(dir, "chunk.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const AWS = "AKIA" + "Q3EXAMPLEKEY7ZZX";
const EDITS = 15; // under the per-session flag cap (20), so every edit shows

beforeAll(async () => {
  db = await import("../src/db.ts");
  const t0 = Date.now() - 60_000;
  for (let i = 0; i < EDITS; i++) {
    db.insertEvent({
      source_app: "orbit", session_id: "big-s", hook_event_type: "PostToolUse", tool_name: "Write",
      tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-5", is_error: 0, error_text: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
      usage_is_cumulative: false, summary: "x", timestamp: t0 + i, chat: null,
      payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, `config/settings${i}.yml`), content: `access_key: ${AWS}\n` } },
    } as never);
  }
});
afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.cfg], ["AGENTGLASS_ROOT", saved.root]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("riskChunkTop: a span past the first row, never past the top, never below the mark", () => {
  expect(db.riskChunkTop(0, 1_436_612, 2_690_497, 20_000)).toBe(1_456_611); // the empty stretch below the first row costs no turn
  expect(db.riskChunkTop(1_456_611, 1_436_612, 2_690_497, 20_000)).toBe(1_476_611); // resumes from the mark
  expect(db.riskChunkTop(0, 10, 15, 20_000)).toBe(15); // never past the top it read to
  expect(db.riskChunkTop(0, null, 99, 5)).toBe(99); // a session with no rows has nothing to chunk
  expect(db.riskChunkTop(7, 3, 99, Infinity)).toBe(99); // no span, no chunking
});

test("a session read in spans ends with the same flags as one read, and no turn reads more than its span", () => {
  expect(db.riskReadSql(1)).not.toContain("LIMIT");
  const whole = db.getSessions(1000).find((r) => r.session_id === "big-s");
  expect(whole?.risks?.length).toBe(EDITS);
  // The 15 edits sit in 15 consecutive ids: a span of 4 takes at least 4 turns.
  const r = db.__riskChunkedFlagsForTest("big-s", 4);
  expect(r.turns).toBeGreaterThanOrEqual(Math.ceil(EDITS / 4));
  expect(JSON.stringify(r.flags)).toBe(JSON.stringify(whole!.risks));
});
