// deriveAgents turns the raw event buffer into the fleet's agent cards — the
// running/waiting/errored/idle status every panel reads, plus the roll-ups
// (events, tools, errors, cost) and subagent tally. It is pure but time-relative
// (it reads Date.now()), so these build events at offsets from a captured `now`
// and keep well clear of the thresholds (STALL 20s, IDLE 5m) so a few ms of
// drift between the two Date.now() reads can never flip a case.
import { test, expect } from "bun:test";
import { deriveAgents, buildTitles } from "../src/lib/derive.ts";
import type { WatchEvent } from "../../shared/types.ts";

const now = Date.now();
const ev = (over: Partial<WatchEvent> = {}): WatchEvent => ({
  id: Math.floor(Math.random() * 1e9),
  source_app: "app",
  session_id: "s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  provider: "Anthropic",
  is_error: 0,
  error_text: null,
  duration_ms: null,
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  cost_usd: 0.01,
  summary: null,
  timestamp: now - 1000,
  payload: {},
  ...over,
});

const only = (events: WatchEvent[], openTools: any[] = []) => {
  const cards = deriveAgents(events, openTools);
  expect(cards.length).toBe(1);
  return cards[0];
};

test("a recent tool event with no error reads as working", () => {
  expect(only([ev({ timestamp: now - 2000 })]).status).toBe("working");
});

test("a Stop is idle, whatever it was doing", () => {
  expect(only([ev({ hook_event_type: "PostToolUse", timestamp: now - 3000 }), ev({ hook_event_type: "Stop", timestamp: now - 1000 })]).status).toBe("idle");
});

test("a permission request is waiting, not working", () => {
  expect(only([ev({ hook_event_type: "PermissionRequest", tool_name: null, timestamp: now - 1000 })]).status).toBe("waiting");
});

test("a recent failure is errored", () => {
  const c = only([ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 2000 })]);
  expect(c.status).toBe("errored");
  expect(c.errors).toBe(1);
});

test("an early error the session worked past is NOT errored anymore", () => {
  // error 30s ago (past STALL_MS), a healthy event since → back to working.
  const c = only([
    ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 30_000 }),
    ev({ hook_event_type: "PostToolUse", timestamp: now - 2000 }),
  ]);
  expect(c.status).toBe("working");
  expect(c.errors).toBe(1); // the lifetime count still remembers it
});

test("silence past the idle window with nothing open is idle", () => {
  expect(only([ev({ timestamp: now - 6 * 60_000 })]).status).toBe("idle"); // 6m > IDLE_MS
});

test("an open tool call keeps a quiet session working (slow, not hung)", () => {
  // A PreToolUse with no matching Post, 6 minutes old: silent past the idle
  // window, but the open call is the evidence it is still building.
  const c = only([ev({ hook_event_type: "PreToolUse", tool_use_id: "t-open", timestamp: now - 6 * 60_000 })]);
  expect(c.status).toBe("working");
  expect(c.runningTool).toBe("Bash");
});

test("a Post that closes the Pre stops it running", () => {
  const c = only([
    ev({ hook_event_type: "PreToolUse", tool_use_id: "t-1", timestamp: now - 4000 }),
    ev({ hook_event_type: "PostToolUse", tool_use_id: "t-1", timestamp: now - 3000 }),
  ]);
  expect(c.runningTool).toBeNull();
});

test("roll-ups sum across a session; subagents are tallied by type", () => {
  const c = only([
    ev({ hook_event_type: "PostToolUse", cost_usd: 0.02, input_tokens: 100, output_tokens: 50, timestamp: now - 5000 }),
    ev({ hook_event_type: "PostToolUse", cost_usd: 0.03, input_tokens: 200, output_tokens: 25, timestamp: now - 4000 }),
    ev({ hook_event_type: "PostToolUse", agent_id: "a1", agent_type: "explorer", timestamp: now - 3500 }),
    ev({ hook_event_type: "PostToolUse", agent_id: "a2", agent_type: "explorer", timestamp: now - 3400 }),
    ev({ hook_event_type: "PostToolUse", agent_id: "a3", agent_type: "planner", timestamp: now - 3300 }),
  ]);
  expect(c.cost).toBeCloseTo(0.08, 6); // 0.02 + 0.03 + 0.01*3 defaults
  expect(c.tools).toBe(5);
  expect(c.subagents).toBe(3);
  expect(c.subagentTypes).toEqual([["explorer", 2], ["planner", 1]]);
});

test("distinct sessions become distinct cards, newest first", () => {
  const cards = deriveAgents([
    ev({ session_id: "old", timestamp: now - 10_000 }),
    ev({ session_id: "new", timestamp: now - 1000 }),
  ]);
  expect(cards.map((c) => c.session_id)).toEqual(["new", "old"]);
});

test("buildTitles prefers a custom title over an ai title, and omits sessions with neither", () => {
  const t = buildTitles([
    { session_id: "s-custom", source_app: "app", custom_title: "My Run", ai_title: "auto" },
    { session_id: "s-ai", source_app: "app", custom_title: null, ai_title: "Refactor the parser" },
    { session_id: "s-none", source_app: "app", custom_title: null, ai_title: null },
  ]);
  expect(t.get("s-custom")).toBe("My Run");
  expect(t.get("s-ai")).toBe("Refactor the parser");
  // A session with no title is left out entirely, so the UI falls back to the
  // uuid rather than being handed an empty string.
  expect(t.get("s-none")).toBeUndefined();
});
