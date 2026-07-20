import { test, expect } from "bun:test";
import { collectAttention, type AttentionInput } from "../src/lib/attention.ts";

const NOW = 1_700_000_000_000;
const input = (over: Partial<AttentionInput> = {}): AttentionInput =>
  ({ gates: [], insights: [], alerts: [], chats: [], agents: [], ...over } as AttentionInput);

const gate = (id: string, over = {}) =>
  ({ id, source_app: "orbit", session_id: "s-" + id, tool_name: "Bash", summary: "", created: NOW, ...over }) as any;
const chat = (id: string, over = {}) =>
  ({ id, title: "chat " + id, attention: "blocked", blockedTool: "Write", messages: [], createdAt: NOW, ...over }) as any;
const agent = (key: string, over = {}) =>
  ({ key, session_id: "sess-" + key, source_app: "orbit", status: "idle", outcome: "unanswered", lastSeen: NOW, ...over }) as any;

test("nothing pending is an empty list, not a zero-length lie", () => {
  expect(collectAttention(input())).toEqual([]);
});

test("a held tool call is collected as blocking", () => {
  const [item] = collectAttention(input({ gates: [gate("g1")] }));
  expect(item.level).toBe("blocking");
  expect(item.source).toBe("gate");
  expect(item.target).toEqual({ kind: "session", id: "s-g1", app: "orbit" });
});

// The gap this whole module exists to close: the panel named "What needs you"
// had no idea a chat could be blocked.
test("a blocked chat appears, and names the tool that was refused", () => {
  const [item] = collectAttention(input({ chats: [chat("c1")] }));
  expect(item.source).toBe("chat");
  expect(item.level).toBe("blocking");
  expect(item.text).toContain("Write");
});

test("a chat that isn't blocked is not collected", () => {
  expect(collectAttention(input({ chats: [chat("c1", { attention: "done" })] }))).toEqual([]);
  expect(collectAttention(input({ chats: [chat("c1", { attention: "none" })] }))).toEqual([]);
});

test("a session that stopped on an unanswered question is collected", () => {
  const [item] = collectAttention(input({ agents: [agent("orbit:a1")] }));
  expect(item.source).toBe("agent");
  expect(item.text).toContain("nobody answered");
});

test("a settled session is not", () => {
  expect(collectAttention(input({ agents: [agent("orbit:a1", { outcome: "settled" })] }))).toEqual([]);
});

test("info insights are commentary and never counted", () => {
  const insights = [{ id: "i1", severity: "info", kind: "spend", title: "spend is up", detail: "", session: null, ts: NOW }] as any;
  expect(collectAttention(input({ insights }))).toEqual([]);
});

// The inversion the merge fixes: deriveAlerts sorts by time alone, so an hour-old
// error outranked something that just stopped to ask you a question.
test("severity beats recency", () => {
  const items = collectAttention(input({
    alerts: [{ id: "old", level: "error", agent: "orbit:x", text: "boom", ts: NOW }] as any,
    gates: [gate("g1", { created: NOW - 60 * 60_000 })],
  }));
  expect(items[0].source).toBe("gate");     // an hour older, still first
  expect(items[1].source).toBe("agent");
});

test("recency breaks ties within a severity", () => {
  const items = collectAttention(input({ gates: [gate("old", { created: NOW - 5000 }), gate("new", { created: NOW })] }));
  expect(items[0].id).toBe("gate:new");
});

// Two detectors describing one stuck session is one problem, not two — the count
// has to reflect problems.
test("the same session raised twice collapses to the more severe", () => {
  const items = collectAttention(input({
    gates: [gate("g1", { session_id: "dup" })],
    agents: [agent("orbit:a1", { session_id: "dup" })],
  }));
  expect(items).toHaveLength(1);
  expect(items[0].level).toBe("blocking");
});

test("items with no target are never merged together", () => {
  const alerts = [
    { id: "a", level: "error", agent: "x", text: "one", ts: NOW },
    { id: "b", level: "error", agent: "y", text: "two", ts: NOW },
  ] as any;
  expect(collectAttention(input({ alerts }))).toHaveLength(2);
});
