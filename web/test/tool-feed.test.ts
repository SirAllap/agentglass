// What the folded tool feed is allowed to hide, and what it never hides.
import { expect, test } from "bun:test";
import { toolFeedSummary, toolLabel } from "../src/lib/toolFeed.ts";
import type { ChatTool } from "../src/lib/chatStore.ts";

const tool = (over: Partial<ChatTool> = {}): ChatTool => ({
  id: "t1", name: "Bash", target: "rg foo", output: null, error: false, ts: 1, ...over,
});

test("counts the calls it is folding", () => {
  const s = toolFeedSummary([tool(), tool({ id: "t2" }), tool({ id: "t3" })]);
  expect(s.n).toBe(3);
  expect(s.failed).toBe(0);
});

test("a failure is never folded silently", () => {
  const s = toolFeedSummary([tool(), tool({ id: "t2", error: true }), tool({ id: "t3", error: true })]);
  expect(s.failed).toBe(2);
});

test("the running call is the most recent one", () => {
  const s = toolFeedSummary([tool({ id: "a", target: "first" }), tool({ id: "b", target: "last" })]);
  expect(s.latest?.id).toBe("b");
});

test("an empty turn has nothing to say", () => {
  const s = toolFeedSummary([]);
  expect(s.n).toBe(0);
  expect(s.latest).toBeNull();
});

test("the label reads like the row: Tool(what it acted on)", () => {
  expect(toolLabel(tool({ name: "Read", target: "/tmp/a.ts" }))).toBe("Read(/tmp/a.ts)");
});

test("a multi-line command is identified by its first line", () => {
  expect(toolLabel(tool({ target: "cd /tmp\nmake test" }))).toBe("Bash(cd /tmp)");
});

test("a tool with no target is just its name", () => {
  expect(toolLabel(tool({ name: "TodoWrite", target: null }))).toBe("TodoWrite");
});
