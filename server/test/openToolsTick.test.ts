import { test, expect } from "bun:test";
import { changesOpenTools, nextOpenToolTick, OPEN_TOOL_TICK_MS } from "../src/openToolsTick.ts";

// An idle machine (nothing open, or nobody watching) must schedule nothing.
test("the safety tick runs only with a client and an open call", () => {
  expect(nextOpenToolTick(0, 3)).toBeNull();
  expect(nextOpenToolTick(2, 0)).toBeNull();
  expect(nextOpenToolTick(1, 1)).toBe(OPEN_TOOL_TICK_MS);
});

import { createOpenToolsPusher } from "../src/openToolsTick.ts";

function rig(clients: number, open: string[]) {
  const sent: unknown[] = [];
  const timers: Array<() => void> = [];
  const state = { clients, open };
  const push = createOpenToolsPusher<string>({
    clientCount: () => state.clients,
    read: () => state.open,
    withEvidence: async (o) => o,
    send: (d) => sent.push(d),
    setTimer: (fn) => { timers.push(fn); return {}; },
  });
  return { push, sent, timers, state };
}

test("a change event pushes once; the same list is not re-sent", async () => {
  const r = rig(1, ["a"]);
  await r.push();
  await r.push();
  expect(r.sent).toEqual([["a"]]);
  r.state.open = ["a", "b"];
  await r.push();
  expect(r.sent.length).toBe(2);
});

test("nobody listening: no push and no tick armed", async () => {
  const r = rig(0, ["a"]);
  await r.push();
  expect(r.sent.length).toBe(0);
  expect(r.timers.length).toBe(0);
});

test("a tick that fires after the last client left pushes nothing", async () => {
  const r = rig(1, ["a"]);
  await r.push();
  expect(r.timers.length).toBe(1);
  r.state.clients = 0;
  r.state.open = ["a", "b"];
  r.timers[0]!();
  await Promise.resolve();
  expect(r.sent.length).toBe(1);
});

test("Stop and SessionEnd push too: an interrupted tool has no Post", () => {
  for (const t of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) expect(changesOpenTools(t)).toBe(true);
  for (const t of ["UserPromptSubmit", "Notification", "SessionStart"]) expect(changesOpenTools(t)).toBe(false);
});

test("both ingest paths and the scope switch push", async () => {
  const src = await Bun.file(import.meta.dir + "/../src/index.ts").text();
  expect(src.match(/changesOpenTools\(event\.hook_event_type\)/g)?.length).toBe(2);
  expect(src).toMatch(/resyncScopeBounded\(\);\n[^\n]*\n\s*if \(res\.ok\) void pushOpenTools\(\)/);
});

test("the list is serialized once per change and the string reaches send", async () => {
  const realStringify = JSON.stringify;
  let calls = 0;
  const sentJson: string[] = [];
  const push = createOpenToolsPusher<string>({
    clientCount: () => 1,
    read: () => ["a", "b"],
    withEvidence: async (o) => o,
    send: (_d, json) => sentJson.push(json),
    setTimer: () => ({}),
  });
  JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => { calls++; return realStringify(...a); }) as typeof JSON.stringify;
  try { await push(); } finally { JSON.stringify = realStringify; }
  expect(calls).toBe(1);
  expect(sentJson).toEqual(['["a","b"]']);
  expect(`{"type":"openTools","data":${sentJson[0]}}`).toBe(realStringify({ type: "openTools", data: ["a", "b"] }));
});

test("yieldFirst: the read waits for the yield, so a push inside a request reads after the answer", async () => {
  const order: string[] = [];
  let release!: () => void;
  const push = createOpenToolsPusher<string>({
    clientCount: () => 1,
    yieldFirst: () => new Promise<void>((r) => { release = r; }),
    read: () => { order.push("read"); return ["a"]; },
    withEvidence: async (o) => o,
    send: () => order.push("send"),
    setTimer: () => ({}),
  });
  const done = push();
  expect(order).toEqual([]); // nothing read synchronously
  release();
  await done;
  expect(order).toEqual(["read", "send"]);
});
