import { test, expect } from "bun:test";
import { changesAffectedBy, changesMemo } from "../src/changesMemo.ts";

// Pure rule: only a finished edit-class tool call can change the changed-path list.
test("only a finished Edit/Write/MultiEdit drops the memo", () => {
  expect(changesAffectedBy({ hook_event_type: "PostToolUse", tool_name: "Edit" })).toBe(true);
  expect(changesAffectedBy({ hook_event_type: "PostToolUse", tool_name: "MultiEdit" })).toBe(true);
  expect(changesAffectedBy({ hook_event_type: "PreToolUse", tool_name: "Edit" })).toBe(false);
  expect(changesAffectedBy({ hook_event_type: "PostToolUse", tool_name: "Bash" })).toBe(false);
  expect(changesAffectedBy({ hook_event_type: "PostToolUse", tool_name: null })).toBe(false);
});

test("memo computes once per scope until dropped", () => {
  const m = changesMemo<string[]>();
  let runs = 0;
  const compute = () => { runs++; return ["/acme/orbit/a.ts"]; };
  m.get("s1", compute); m.get("s1", compute);
  expect(runs).toBe(1);
  m.get("s2", compute);
  expect(runs).toBe(2);
  m.drop();
  m.get("s2", compute);
  expect(runs).toBe(3);
});

// Source rule: every place that drops the path memo also drops the change-list memo (GET /changes).
test("getChanges is memoised and dropped wherever the path memo is", async () => {
  const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
  const drops = src.match(/changedPathsMemo\.drop\(\);/g)?.length ?? 0;
  const both = src.match(/changedPathsMemo\.drop\(\); changeListMemo\.drop\(\);/g)?.length ?? 0;
  expect(drops).toBeGreaterThan(0);
  expect(both).toBe(drops);
  expect(src).toContain("changeListMemo.get(");
  // A session-scoped call is never held: it is one card's list, asked once.
  expect(src).toMatch(/if \(sessionId\) return readChanges\(/);
});
