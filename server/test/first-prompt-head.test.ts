/*
 * firstPrompts reads only the head of each UserPromptSubmit payload, and
 * /prs/for-branch waits for the spawn broker instead of forking gh on the loop.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptTitle } from "../../shared/sessionTitle.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-fph-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "fph.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

const T0 = Date.now() - 3_600_000;
const ev = (session_id: string, text: string) => ({
  source_app: "proj", session_id, hook_event_type: "UserPromptSubmit", tool_name: null,
  tool_use_id: null, agent_id: null, agent_type: null, model_name: "m", is_error: 0, error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false, summary: "x", timestamp: T0, chat: null,
  payload: { project_path: ROOT, prompt: text },
});

const BIG = `Fix the ünïcode "title" \\ path\nsecond line\n` + "x".repeat(200 * 1024);
let db: typeof import("../src/db.ts");

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(ev("big", BIG) as any);
  db.insertEvent(ev("small", "Short ask") as any);
  // A session row comes from any other event of the session.
  for (const id of ["big", "small"]) {
    db.insertEvent({ ...ev(id, ""), hook_event_type: "PostToolUse", tool_name: "Bash", timestamp: T0 + 1_000,
      payload: { project_path: ROOT } } as any);
  }
});

describe("firstPrompts reads the head of the payload", () => {
  test("a 200 KB prompt gives the same title as the whole prompt would", () => {
    process.env.AGENTGLASS_ROOT = ROOT;
    const rows = new Map(db.getSessions(50).map((s) => [s.session_id, s]));
    expect(promptTitle(rows.get("big")?.first_prompt)).toBe(promptTitle(BIG));
    expect(rows.get("small")?.first_prompt).toBe("Short ask");
  });

  test("the SQL reads at most N characters of each payload", () => {
    const src = readFileSync(join(import.meta.dir, "../src/db.ts"), "utf8");
    const n = Number(/const FIRST_PROMPT_CHARS = (\d+);/.exec(src)?.[1]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(4096);
    expect(src).toContain("substr(payload, 1, ${FIRST_PROMPT_CHARS}) AS payload");
    expect(src).not.toMatch(/SELECT session_id, payload, MIN\(timestamp\)/);
  });
});

describe("/prs/for-branch before the broker is up", () => {
  test("waits for the broker before the first gh call, on the loop no Bun.spawn is made first", () => {
    const src = readFileSync(join(import.meta.dir, "../src/prs.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function prsForBranch"));
    const up = body.indexOf("await brokerUp()");
    const ask = body.indexOf("ghJson<Record<string, unknown>[]>");
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(ask);
  });
});
