import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-insights-group-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "insights-grp.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let insights: typeof import("../src/insights.ts");

const now = Date.now();
const event = (app: string, session: string, cmd: string, i: number) => ({
  source_app: app,
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
  payload: { project_path: ROOT, tool_input: { command: cmd } },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  insights = await import("../src/insights.ts");
  
  // App 1 loop
  for (let i = 0; i < 7; i++) {
    db.insertEvent(event("app-alpha", "s-1", "pytest test_a.py", i) as any);
  }
  // App 2 loop with different app
  for (let i = 0; i < 7; i++) {
    db.insertEvent(event("app-beta", "s-2", "npm test", i) as any);
  }
});

describe("insights GROUP BY source_app", () => {
  test("correctly attributes loops to their exact source_app", () => {
    const list = insights.getInsights();
    const alphaLoop = list.find((item) => item.session?.startsWith("app-alpha:"));
    const betaLoop = list.find((item) => item.session?.startsWith("app-beta:"));
    
    expect(alphaLoop).toBeDefined();
    expect(betaLoop).toBeDefined();
    expect(alphaLoop?.detail).toBe("pytest test_a.py");
    expect(betaLoop?.detail).toBe("npm test");
  });
});
