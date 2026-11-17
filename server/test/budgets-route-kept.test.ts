// GET /budgets scanned every event for the model list and summed a budget
// period per budget on each open of the pane (a 1.9 s stall on a 1.5 GB DB).
// The model list is now kept until a write that can change it.
import { beforeAll, expect, test } from "bun:test";

// No AGENTGLASS_DB here: one bun process shares one db module, so whichever
// file imports it first fixes the path. This file takes the db as it is.
let budget: typeof import("../src/budget.ts");
let db: typeof import("../src/db.ts");

beforeAll(async () => {
  db = await import("../src/db.ts");
  budget = await import("../src/budget.ts");
});

const event = (over: Record<string, unknown>) => db.insertEvent({
  source_app: "orbit", session_id: "budgets-route-1", hook_event_type: "PostToolUse", tool_name: "Bash",
  tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-budgetsroute-test", is_error: 0, error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false, summary: "", timestamp: Date.now(), payload: {},
  ...over,
} as never);

test("the costed-model list is one scan until an event with a cost lands", () => {
  budget.__forgetGateSpend();
  const n0 = budget.costedModelsScans;
  const first = budget.costedModelsKept();
  expect(first).toEqual(db.costedModels());
  budget.costedModelsKept();
  expect(budget.costedModelsScans - n0).toBe(1);

  event({ hook_event_type: "PreToolUse" });
  budget.costedModelsKept();
  expect(budget.costedModelsScans - n0).toBe(1);

  event({ usage: { input_tokens: 200_000, output_tokens: 50_000, cache_creation_tokens: 0, cache_read_tokens: 0 } });
  const after = budget.costedModelsKept();
  expect(budget.costedModelsScans - n0).toBe(2);
  expect(after).toEqual(db.costedModels());
  expect(after).toContain("claude-budgetsroute-test");
});

test("the route reads the kept sums, not the scans", async () => {
  const src = (await Bun.file(new URL("../src/index.ts", import.meta.url)).text())
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  expect(src).toContain("status: budgetStatus(undefined, undefined, gateSpend), models: costedModelsKept()");
});
