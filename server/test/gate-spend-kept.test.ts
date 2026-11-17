// With a budget set, every tool call's gate check summed a whole budget
// period of events on the server's only thread. The gate now keeps the sum
// until a write that can change it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gatespend-"));
const before = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME };
process.env.AGENTGLASS_DB = join(dir, "spend.db");
process.env.XDG_CONFIG_HOME = dir;

let budget: typeof import("../src/budget.ts");
let db: typeof import("../src/db.ts");

beforeAll(async () => {
  db = await import("../src/db.ts");
  budget = await import("../src/budget.ts");
});
afterAll(() => {
  if (before.db === undefined) delete process.env.AGENTGLASS_DB; else process.env.AGENTGLASS_DB = before.db;
  if (before.cfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before.cfg;
  rmSync(dir, { recursive: true, force: true });
});

const event = (over: Record<string, unknown>) => db.insertEvent({
  source_app: "orbit", session_id: "gatespend-1", hook_event_type: "PostToolUse", tool_name: "Bash",
  tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-4-8", is_error: 0, error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false, summary: "", timestamp: Date.now(), payload: {},
  ...over,
} as never);

test("two asks with nothing spent between them are one sum, and the answer is the fresh one", () => {
  budget.__forgetGateSpend();
  const day = new Date().toISOString().slice(0, 10);
  const ask = { fromDay: day, toDay: day, root: null, model: null };
  const n0 = budget.gateSpendSums;
  const a = budget.gateSpend(ask);
  const b = budget.gateSpend(ask);
  expect(budget.gateSpendSums - n0).toBe(1);
  expect(b).toBe(a);
  expect(a).toBe(db.spendBetween(ask));

  // A tool call's own event carries no cost: it must not throw the answer away.
  event({ hook_event_type: "PreToolUse" });
  budget.gateSpend(ask);
  expect(budget.gateSpendSums - n0).toBe(1);

  // An event that costs something does, at once: the next ask is the new sum.
  event({ usage: { input_tokens: 200_000, output_tokens: 50_000, cache_creation_tokens: 0, cache_read_tokens: 0 } });
  const c = budget.gateSpend(ask);
  expect(budget.gateSpendSums - n0).toBe(2);
  expect(c).toBe(db.spendBetween(ask));
  expect(c).toBeGreaterThan(a);
});

test("the gate's two budget reads go through the kept sum", async () => {
  const strip = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const rules = strip(await Bun.file(new URL("../src/gaterules.ts", import.meta.url)).text());
  const b = strip(await Bun.file(new URL("../src/budget.ts", import.meta.url)).text());
  expect(rules).toContain("budgetStatus(readBudgets().filter((b) => !b.model), undefined, gateSpend)");
  expect(b).toContain("overBudgetFor(cwd || sessionCwd(session), budgetStatus(undefined, undefined, gateSpend))");
});
