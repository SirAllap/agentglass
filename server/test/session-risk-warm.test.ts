// The first session list after a start parsed every edit of every listed
// session in one call: 427 ms of the server's only thread, measured two
// seconds after a boot. The same reading is now done before anybody asks,
// a batch per turn of the loop.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-riskwarm-"));
const ROOT = join(dir, "orbit");
mkdirSync(ROOT, { recursive: true });
const saved = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
process.env.AGENTGLASS_DB = join(dir, "warm.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const AWS = "AKIA" + "Q3EXAMPLEKEY7ZZX";
const N = 45;

beforeAll(async () => {
  db = await import("../src/db.ts");
  const t0 = Date.now() - 60_000;
  for (let i = 0; i < N; i++) {
    db.insertEvent({
      source_app: "orbit", session_id: `warm-s${i}`, hook_event_type: "PostToolUse", tool_name: "Write",
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

test("the flags are read in batches before the list is asked for, and the list then reads none", async () => {
  expect(N).toBeGreaterThan(db.RISK_WARM_BATCH * 2);
  const before = db.riskColdReads;
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  db.warmSessionRisks(1000, 0);
  // Nothing was read on the caller's turn: the first batch waits for the loop.
  expect(db.riskColdReads).toBe(before);
  for (let i = 0; i < 400 && db.__risksWarming(); i++) await Bun.sleep(10);
  clearInterval(timer);
  expect(db.__risksWarming()).toBe(false);
  expect(db.riskColdReads - before).toBeGreaterThanOrEqual(N);
  // More than one batch, with the loop free between them.
  expect(ticks).toBeGreaterThan(1);

  const warm = db.riskColdReads;
  process.env.AGENTGLASS_ROOT = ROOT;
  const rows = db.getSessions(997);
  expect(db.riskColdReads).toBe(warm);
  const mine = rows.filter((r) => r.session_id.startsWith("warm-s"));
  expect(mine.length).toBe(N);
  // And the answer is the full one: every one of them carries its flag.
  expect(mine.every((r) => (r.risks ?? []).length > 0)).toBe(true);
});

test("a list asked for before the warm is done reads at most one batch, and the rest come a poll later", async () => {
  // The first GET /sessions after a restart read every session still owed in one call:
  // 1468 ms on the live server, four seconds after a boot.
  const COLD = db.RISK_WARM_BATCH * 3;
  for (let i = 0; i < COLD; i++) {
    db.insertEvent({
      source_app: "orbit", session_id: `cold-s${i}`, hook_event_type: "PostToolUse", tool_name: "Write",
      tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-5", is_error: 0, error_text: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
      usage_is_cumulative: false, summary: "x", timestamp: Date.now() + i, chat: null,
      payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, `config/cold${i}.yml`), content: `access_key: ${AWS}\n` } },
    } as never);
  }
  process.env.AGENTGLASS_ROOT = ROOT;
  const before = db.riskColdReads;
  const first = db.getSessions(996).filter((r) => r.session_id.startsWith("cold-s"));
  expect(first.length).toBe(COLD);
  expect(db.riskColdReads - before).toBe(db.RISK_WARM_BATCH);
  expect(first.filter((r) => (r.risks ?? []).length > 0).length).toBe(db.RISK_WARM_BATCH);
  // The rest are read by the warm turns, off the request.
  expect(db.__risksWarming()).toBe(true);
  for (let i = 0; i < 400 && db.__risksWarming(); i++) await Bun.sleep(10);
  expect(db.__risksWarming()).toBe(false);
  expect(db.riskColdReads - before).toBe(COLD);
  // The short answer was not kept: the next poll carries every flag.
  const next = db.getSessions(996).filter((r) => r.session_id.startsWith("cold-s"));
  expect(next.every((r) => (r.risks ?? []).length > 0)).toBe(true);
});

test("the server warms them when it starts", async () => {
  const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  // The boot prune now runs a few seconds after listen (see BOOT_PRUNE_DELAY_MS), so
  // the warm is pinned to its own top-level call, not to the line after prune().
  expect(index).toContain("\n// The session list's flags, read before the first poll asks for them: see warmSessionRisks.\nbootStep(\"session-risk-warm\", () => { warmSessionRisks(); });\n");
});

test("by default the first warm turn waits past first paint, so boot answers /health before it", async () => {
  expect(db.RISK_WARM_START_MS).toBeGreaterThanOrEqual(2000);
  expect(db.RISK_WARM_BATCH).toBeLessThanOrEqual(5);
  // A session the first test's warm did not see, so something is owed.
  db.insertEvent({
    source_app: "orbit", session_id: "warm-late", hook_event_type: "PostToolUse", tool_name: "Write",
    tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-5", is_error: 0, error_text: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
    usage_is_cumulative: false, summary: "x", timestamp: Date.now(), chat: null,
    payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, "config/late.yml"), content: `access_key: ${AWS}\n` } },
  } as never);
  const before = db.riskColdReads;
  db.warmSessionRisks(1000);
  await Bun.sleep(150);
  // Still owed, still waiting: nothing was read in the first 150 ms.
  expect(db.__risksWarming()).toBe(true);
  expect(db.riskColdReads).toBe(before);
});
