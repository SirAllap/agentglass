// What counts as life under a session: a subagent's recent calls, a background
// shell, and the stalled rule that reads them. Fixtures are invented.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStalled, STALLED_AFTER_MS } from "../../shared/fieldRules.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-life-"));
process.env.AGENTGLASS_DB = join(dir, "life.db");
process.env.XDG_CONFIG_HOME = dir;
delete process.env.AGENTGLASS_ROOT;

let db: typeof import("../src/db.ts");
let lantern: typeof import("../src/lantern.ts");
const NOW = Date.now();
const MIN = 60_000;
const ev = (session: string, type: string, at: number, over: Record<string, unknown> = {}) => ({
  source_app: "app", session_id: session, hook_event_type: type, tool_name: null, tool_use_id: null,
  agent_id: null, agent_type: null, model_name: "m", is_error: 0, error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false, summary: "x", payload: {}, chat: null, timestamp: at, ...over,
});
const bg = (session: string, at: number, task: string) =>
  ev(session, "PostToolUse", at, { tool_name: "Bash", payload: { tool_input: { command: "sleep 900", run_in_background: true }, tool_response: { backgroundTaskId: task } } });

beforeAll(async () => {
  db = await import("../src/db.ts");
  lantern = await import("../src/lantern.ts");
});

describe("lifeSigns", () => {
  test("a subagent with recent calls and no SubagentStop is alive; once stopped, or long quiet, it is not", () => {
    db.insertEvent(ev("s-live", "PreToolUse", NOW - 2 * MIN, { tool_name: "Read", agent_id: "a1" }) as any);
    db.insertEvent(ev("s-done", "PreToolUse", NOW - 2 * MIN, { tool_name: "Read", agent_id: "a2" }) as any);
    db.insertEvent(ev("s-done", "SubagentStop", NOW - MIN, { agent_id: "a2" }) as any);
    db.insertEvent(ev("s-old", "PreToolUse", NOW - 11 * MIN, { tool_name: "Read", agent_id: "a3" }) as any);
    const l = lantern.lifeSigns(["s-live", "s-done", "s-old"], NOW);
    expect(l.get("s-live")?.subagent).toBe(NOW - 2 * MIN);
    expect(l.get("s-done")?.subagent).toBeUndefined();
    expect(l.get("s-old")?.subagent).toBeUndefined();
  });

  test("a background shell is alive inside the cap, and a TaskStop for its task ends it", () => {
    db.insertEvent(bg("s-sh", NOW - 5 * MIN, "b1") as any);
    db.insertEvent(bg("s-killed", NOW - 5 * MIN, "b2") as any);
    db.insertEvent(ev("s-killed", "PostToolUse", NOW - 4 * MIN, { tool_name: "TaskStop", payload: { tool_input: { task_id: "b2" } } }) as any);
    db.insertEvent(bg("s-capped", NOW - 31 * MIN, "b3") as any);
    const l = lantern.lifeSigns(["s-sh", "s-killed", "s-capped"], NOW);
    expect(l.get("s-sh")?.shell).toBe(NOW - 5 * MIN);
    expect(l.get("s-killed")?.shell).toBeUndefined();
    expect(l.get("s-capped")?.shell).toBeUndefined();
  });

  test("a main-turn Stop is read, a subagent's Stop is not", () => {
    db.insertEvent(ev("s-stop", "Stop", NOW - 3 * MIN) as any);
    db.insertEvent(ev("s-stop", "Stop", NOW - MIN, { agent_id: "a9" }) as any);
    expect(lantern.lifeSigns(["s-stop"], NOW).get("s-stop")?.lastStop).toBe(NOW - 3 * MIN);
  });
});

describe("isStalled", () => {
  const base = { doing: "the export", paneId: "%4", state: "idle" as const, saidAt: NOW - 90 * MIN, turnOpen: true, lastLifeSign: NOW - STALLED_AFTER_MS - 1 };
  test("claimed work, open turn, 20 min of silence", () => expect(isStalled(base, NOW)).toBe(true));
  test("not under 20 min", () => expect(isStalled({ ...base, lastLifeSign: NOW - 19 * MIN }, NOW)).toBe(false));
  test("not when something is alive", () => expect(isStalled({ ...base, alive: true }, NOW)).toBe(false));
  test("not when the turn ended: that is finished, not stuck", () => expect(isStalled({ ...base, turnOpen: false }, NOW)).toBe(false));
  test("not without a claim", () => expect(isStalled({ ...base, doing: undefined }, NOW)).toBe(false));
  test("not when it waits on a person", () => expect(isStalled({ ...base, needsYou: { kind: "permission", since: NOW } }, NOW)).toBe(false));
});
