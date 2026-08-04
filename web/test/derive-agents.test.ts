// deriveAgents turns the raw event buffer into the fleet's agent cards — the
// running/waiting/errored/idle status every panel reads, plus the roll-ups
// (events, tools, errors, cost) and subagent tally. It is pure but time-relative
// (it reads Date.now()), so these build events at offsets from a captured `now`
// and keep well clear of the thresholds (STALL 20s, IDLE 5m) so a few ms of
// drift between the two Date.now() reads can never flip a case.
import { test, expect } from "bun:test";
import { deriveAgents, deriveAlerts, buildTitles, buildRollups } from "../src/lib/derive.ts";
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

// A failure rate needs a numerator and denominator drawn from the same
// population (#248 F6). `errors` counts every errored event — an OTLP source
// flags "Turn complete" spans, and any event carrying a top-level error string
// gets it — while the denominator is tool calls only. So a session whose every
// tool call succeeded raised "high failure rate 150%".
test("a failure rate counts tool failures, not every errored event", () => {
  const events = [
    ...Array.from({ length: 4 }, (_, i) =>
      ev({ hook_event_type: "PostToolUse", is_error: 0, timestamp: now - 5000 - i })),
    ...Array.from({ length: 6 }, (_, i) =>
      ev({ hook_event_type: "Turn complete", tool_name: null, is_error: 1, timestamp: now - 4000 - i })),
  ];
  const card = only(events);
  expect(card.tools).toBe(4);
  expect(card.errors).toBe(6);   // still the honest "how much went wrong"
  expect(card.toolErrors).toBe(0); // ...but no tool failed
  expect(deriveAlerts([card]).filter((a) => a.id.startsWith("rate:"))).toEqual([]);
});

test("a real tool failure still raises the rate alert", () => {
  const events = [
    ...Array.from({ length: 2 }, (_, i) =>
      ev({ hook_event_type: "PostToolUse", is_error: 0, timestamp: now - 5000 - i })),
    ...Array.from({ length: 3 }, (_, i) =>
      ev({ hook_event_type: "PostToolUseFailure", is_error: 1, timestamp: now - 4000 - i })),
  ];
  const card = only(events);
  expect(card.toolErrors).toBe(3);
  const rate = deriveAlerts([card]).filter((a) => a.id.startsWith("rate:"));
  expect(rate.length).toBe(1);
  expect(rate[0].text).toBe("high failure rate 60%");
});

// The card's cost and tokens must not come from a window (#248 F8).
//
// deriveAgents summed them over the live event buffer, which is capped at
// MAX_EVENTS (2000) across the whole fleet and seeded with just 300 events on
// a fresh load. A long-running session therefore showed the cost of whichever
// handful of its events survived the trim — dollars of real spend rendering as
// cents right after a reload, while /stats had it right the whole time.
const rollup = (over: Partial<import("../../shared/types.ts").SessionRollup> = {}) => ({
  session_id: "s1", source_app: "app", model_name: "claude-opus-4-8",
  started_at: now - 60_000, ended_at: null, last_seen: now - 1000,
  event_count: 5000, tool_count: 900, error_count: 0,
  input_tokens: 900_000, output_tokens: 100_000,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 12.34,
  ...over,
} as import("../../shared/types.ts").SessionRollup);

test("a server roll-up beats the truncated buffer", () => {
  // Two events survive the trim; the session really produced five thousand.
  const events = [ev({ cost_usd: 0.01 }), ev({ cost_usd: 0.01 })];
  const buffered = only(events);
  expect(buffered.cost).toBeCloseTo(0.02, 6); // what the card used to show

  const card = deriveAgents(events, [], undefined, buildRollups([rollup()]))[0];
  expect(card.cost).toBeCloseTo(12.34, 6);
  expect(card.tokens).toBe(1_000_000);
  expect(card.tools).toBe(900);
});

test("and it carries the server's weighted token figure, not a raw sum", () => {
  // #298. The client has no price table, so the weighting happens on the server
  // and rides along on the roll-up. Dropping it here — which is what
  // `buildRollups` narrowing the row used to do — silently puts the fleet back
  // on `input + output`: a number that adds a token costing five to one costing
  // a tenth, and ignores the cache classes entirely.
  const r = rollup({
    input_tokens: 900_000, output_tokens: 100_000,
    cache_creation_tokens: 50_000, cache_read_tokens: 8_000_000,
    equiv_tokens: 2_262_500,
  });
  const card = deriveAgents([ev()], [], undefined, buildRollups([r]))[0];
  expect(card.tokens).toBe(2_262_500);
  // Not the sum the pane used to show, and not the raw total either.
  expect(card.tokens).not.toBe(1_000_000);
  expect(card.tokens).toBeLessThan(9_050_000);
});

test("a roll-up from a server too old to weight falls back rather than to zero", () => {
  // `equiv_tokens` is optional. Absent has to mean *unknown* — a fleet card
  // reading 0 tokens next to $12.34 of real spend is a worse answer than the
  // unweighted count it replaces, and it is the one a `?? 0` would produce.
  const card = deriveAgents([ev()], [], undefined, buildRollups([rollup({ equiv_tokens: undefined })]))[0];
  expect(card.tokens).toBe(1_000_000);
});

test("a burst that beat the 30s poll is not rounded back down", () => {
  // The buffer has more than the roll-up knows about yet. A headline number
  // must never read backwards while you are watching it.
  const events = Array.from({ length: 3 }, () => ev({ cost_usd: 10 }));
  const card = deriveAgents(events, [], undefined, buildRollups([rollup({ cost_usd: 12.34 })]))[0];
  expect(card.cost).toBeCloseTo(30, 6);
});

test("a session the poll has not returned still falls back to the buffer", () => {
  const events = [ev({ session_id: "unseen", cost_usd: 0.25 })];
  const card = deriveAgents(events, [], undefined, buildRollups([rollup()]))[0];
  expect(card.cost).toBeCloseTo(0.25, 6);
});

// The rate rule divides by a.tools. Moving a lifetime tool count under a
// windowed error count would fire "high failure rate" on long-dead history.
test("the roll-up does not leak into the failure-rate inputs", () => {
  const events = [
    ...Array.from({ length: 2 }, () => ev({ hook_event_type: "PostToolUse", is_error: 0 })),
    ...Array.from({ length: 3 }, () => ev({ hook_event_type: "PostToolUseFailure", is_error: 1 })),
  ];
  const card = deriveAgents(events, [], undefined, buildRollups([rollup({ tool_count: 900 })]))[0];
  expect(card.errors).toBe(3);
  expect(card.toolErrors).toBe(3);
  // tools took the roll-up, so the rate falls — that is the honest reading of
  // a lifetime denominator, and it must not be able to invent a failure.
  expect(card.tools).toBe(900);
  expect(deriveAlerts([card]).filter((a) => a.id.startsWith("rate:"))).toEqual([]);
});

// ---------------------------------------------------------------------------
// Why an agent stopped.
//
// The reason has always been on the event — a PermissionRequest names the tool
// it is asking for, a Notification carries the message the agent raised — and
// the server reads both to write the desktop notification. This side used to
// throw them away and write one constant string, so the alert's only job was
// the one thing it could not do.
// ---------------------------------------------------------------------------

const waitText = (card: any): string | undefined =>
  deriveAlerts([card]).find((a) => a.id.startsWith("wait:"))?.text;

test("a notification's own message becomes the alert", () => {
  const card = only([ev({
    hook_event_type: "Notification",
    tool_name: null,
    timestamp: now - 1000,
    payload: { message: "Claude is waiting for your input" },
  })]);
  expect(card.status).toBe("waiting");
  expect(card.needBecause).toBe("Claude is waiting for your input");
  expect(waitText(card)).toBe("Claude is waiting for your input");
});

test("a permission request names the tool it wants", () => {
  const card = only([ev({ hook_event_type: "PermissionRequest", tool_name: "Bash", timestamp: now - 1000 })]);
  expect(waitText(card)).toBe("wants to run Bash");
});

test("a notification with no message still says something true", () => {
  const card = only([ev({ hook_event_type: "Notification", tool_name: null, timestamp: now - 1000, payload: {} })]);
  expect(waitText(card)).toBe("raised a notification");
});

// The reason is read only while the card is `waiting`, and `waiting` is decided
// by the latest event. If the two could disagree, a card would carry the reason
// for a block it is no longer in.
test("a reason does not outlive the block it belongs to", () => {
  const card = only([
    ev({ hook_event_type: "Notification", tool_name: null, timestamp: now - 3000, payload: { message: "answer me" } }),
    ev({ hook_event_type: "PostToolUse", timestamp: now - 1000 }),
  ]);
  expect(card.status).toBe("working");
  expect(card.needBecause).toBe("");
});

// Where it is running: needed to say which project an alert belongs to, and to
// have any hope of pointing at the terminal it is waiting in.
test("the card keeps the directory and project it last reported", () => {
  const card = only([
    ev({ timestamp: now - 3000, payload: { cwd: "/home/x/code/app-wt", project_path: "/home/x/code/app" } }),
    // A later event that carries neither must not blank what the first knew.
    ev({ timestamp: now - 1000, payload: {} }),
  ]);
  expect(card.cwd).toBe("/home/x/code/app-wt");
  expect(card.project).toBe("/home/x/code/app");
});
