// GET /agents/board asks for every drawn session's facts on every poll. An idle
// session's answer is kept until it writes an event, so a poll with nothing new
// asks the events table for nothing. Fixtures are invented.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-board-memo-"));
process.env.AGENTGLASS_DB = join(dir, "memo.db");
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

beforeAll(async () => {
  db = await import("../src/db.ts");
  lantern = await import("../src/lantern.ts");
});

test("an idle session is read once; a session that writes an event is read again, and only it", () => {
  const ids = ["orbit-a", "orbit-b", "orbit-c"];
  for (const id of ids) {
    db.insertEvent(ev(id, "UserPromptSubmit", NOW - 9 * MIN, { payload: { prompt: "Fix the queue retry" } }) as any);
    db.insertEvent(ev(id, "PreToolUse", NOW - 8 * MIN, { tool_name: "Read", payload: { tool_input: { file_path: "/work/orbit/q.ts" } } }) as any);
    db.insertEvent(ev(id, "Stop", NOW - 7 * MIN) as any);
  }
  lantern.__resetBoardMemo();
  const first = lantern.sessionFacts(ids);
  lantern.lifeSigns(ids, NOW);
  expect(lantern.eventFactReads).toBe(6); // three sessions, two readers

  // Polls with nothing new: the table is not asked again, and the answer is the same.
  for (let i = 1; i <= 5; i++) {
    expect(lantern.sessionFacts(ids)).toEqual(first);
    expect(lantern.lifeSigns(ids, NOW + i * 1000).get("orbit-a")?.lastStop).toBe(NOW - 7 * MIN);
  }
  expect(lantern.eventFactReads).toBe(6);

  // One session moves: only that one is read again, and the new event shows.
  db.insertEvent(ev("orbit-b", "Stop", NOW - MIN) as any);
  const after = lantern.sessionFacts(ids);
  expect(after.get("orbit-b")?.turns).toBe(2);
  expect(after.get("orbit-a")?.turns).toBe(1);
  expect(lantern.lifeSigns(ids, NOW + 6000).get("orbit-b")?.lastStop).toBe(NOW - MIN);
  expect(lantern.eventFactReads).toBe(8);
});

test("a kept windowed answer ages out with the clock, without a read", () => {
  db.insertEvent(ev("orbit-sub", "PreToolUse", NOW - 2 * MIN, { tool_name: "Read", agent_id: "a1" }) as any);
  lantern.__resetBoardMemo();
  expect(lantern.lifeSigns(["orbit-sub"], NOW).get("orbit-sub")?.subagent).toBe(NOW - 2 * MIN);
  // Nine minutes on, the call is past the ten-minute window: no longer alive, and not re-read.
  expect(lantern.lifeSigns(["orbit-sub"], NOW + 9 * MIN).get("orbit-sub")?.subagent).toBeUndefined();
  expect(lantern.eventFactReads).toBe(1);
});

test("an erase or a retention prune drops every kept answer", () => {
  const DAY = 24 * 60 * MIN;
  for (const [id, at] of [["orbit-erase", NOW - 5 * MIN], ["orbit-old", NOW - 20 * DAY]] as const) {
    db.insertEvent(ev(id, "UserPromptSubmit", at - MIN) as any);
    db.insertEvent(ev(id, "Stop", at) as any);
  }
  lantern.__resetBoardMemo();
  expect(lantern.sessionFacts(["orbit-old"]).get("orbit-old")?.turns).toBe(1);
  const pruned = db.pruneOldRows();
  expect(pruned.events).toBeGreaterThan(0);
  const before = lantern.eventFactReads;
  expect(lantern.sessionFacts(["orbit-old"]).get("orbit-old")?.turns ?? 0).toBe(0);
  expect(lantern.eventFactReads).toBe(before + 1);

  expect(lantern.sessionFacts(["orbit-erase"]).get("orbit-erase")?.turns).toBe(1);
  db.eraseHistory();
  const reads = lantern.eventFactReads;
  expect(lantern.sessionFacts(["orbit-erase"]).get("orbit-erase")?.turns ?? 0).toBe(0);
  expect(lantern.eventFactReads).toBe(reads + 1);
});
