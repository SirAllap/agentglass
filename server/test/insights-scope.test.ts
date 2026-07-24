// Insights must be scoped like every other metric. A cockpit scoped to one
// project must not surface another project's runaway loop, fast burn, or failure
// rate — the over-inclusion failure the repo already guards for its other event
// queries (scope.test.ts), but which getInsights() never applied. Both
// directions are asserted: what should appear does, and what should not still
// does not (project isolation, the highest-risk class here).
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-insights-scope-"));
const SCOPED = join(dir, "scoped");
const OTHER = join(dir, "other");
const MONO = join(dir, "mono"); // root outside the scope, but its turn ran inside it (cwd)
for (const p of [SCOPED, OTHER, MONO]) mkdirSync(p, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "insights.db");
process.env.AGENTGLASS_ROOT = SCOPED; // read once at db.ts/config.ts import, so set before the dynamic import
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let insights: typeof import("../src/insights.ts");

const now = Date.now();
// One loop = >=6 identical Bash PreToolUse in a session within 30m.
const loopEvent = (project: string, session: string, cmd: string, i: number, over: Record<string, unknown> = {}) => ({
  source_app: project.split("/").pop()!,
  session_id: session,
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: `${session}-${i}`,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "",
  timestamp: now - i * 1000,
  payload: { project_path: project, tool_input: { command: cmd }, ...over },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  insights = await import("../src/insights.ts");
  const loop = (project: string, session: string, over: Record<string, unknown> = {}) => {
    for (let i = 0; i < 8; i++) db.insertEvent(loopEvent(project, session, "npm run build", i, over) as any);
  };
  loop(SCOPED, "s-in"); // in scope
  loop(OTHER, "s-out"); // out of scope — must not leak
  loop(MONO, "s-cwd", { cwd: SCOPED + "/wt/x" }); // in scope via the cwd the turn ran in

  // A second, differently-shaped query (SUM(cost)/HAVING) — a fast-burn session
  // over $15 in 15m — to prove the scope guard covers more than the loop query.
  const burn = (project: string, session: string) => {
    // cost is computed from usage at insert (opus input is $5/M), so 2M input
    // tokens ≈ $10/event; four events ≈ $40, over the $15 fast-burn threshold.
    for (let i = 0; i < 4; i++) db.insertEvent({
      source_app: project.split("/").pop()!, session_id: session, hook_event_type: "PostToolUse",
      tool_name: "Bash", tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-4-8",
      is_error: 0, error_text: null,
      usage: { input_tokens: 2_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      usage_is_cumulative: false, summary: "", timestamp: now - i * 1000,
      payload: { project_path: project }, chat: null,
    } as any);
  };
  burn(SCOPED, "b-in");
  burn(OTHER, "b-out");
});

const loopIds = () => insights.getInsights().filter((i) => i.kind === "loop").map((i) => i.id);

describe("insights are scoped to the project", () => {
  test("a loop in the scoped project surfaces", () => {
    expect(loopIds().some((id) => id.startsWith("loop:s-in:"))).toBe(true);
  });

  test("a loop in ANOTHER project does not leak in", () => {
    expect(loopIds().some((id) => id.startsWith("loop:s-out:"))).toBe(false);
  });

  test("a loop whose turn ran inside the scope (via cwd) is included", () => {
    expect(loopIds().some((id) => id.startsWith("loop:s-cwd:"))).toBe(true);
  });

  test("a second insight kind (fast burn) is scoped too, not just loops", () => {
    const spendIds = insights.getInsights().filter((i) => i.kind === "spend").map((i) => i.id);
    expect(spendIds).toContain("spend:b-in"); // in-scope fast burn surfaces
    expect(spendIds).not.toContain("spend:b-out"); // another project's does not leak
  });
});
