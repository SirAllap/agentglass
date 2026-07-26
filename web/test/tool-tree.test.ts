import { test, expect } from "bun:test";
import { buildRows } from "../src/lib/toolTree.ts";
import type { TimelineEntry } from "../../shared/types.ts";

// Subagent turns report the parent's session id, so the server hands us one flat
// list for what were really several concurrent threads. These pin the rebuild —
// the thing that decides whether an `Explore` that ran 111 tools reads as one
// row you can open or as 111 rows wedged through the main thread's own.

let t = 0;
const tool = (name: string, target: string, extra: Partial<TimelineEntry> = {}): TimelineEntry =>
  ({ kind: "tool", ts: ++t, tool: name, target, ...extra });
const msg = (text: string, extra: Partial<TimelineEntry> = {}): TimelineEntry =>
  ({ kind: "message", ts: ++t, role: "assistant", text, ...extra });

test("a plain timeline passes through untouched", () => {
  const rows = buildRows([msg("thinking"), tool("Read", "a.ts"), tool("Bash", "ls")]);
  expect(rows.map((r) => r.kind)).toEqual(["message", "tool", "tool"]);
  expect(rows.every((r) => r.kind !== "tool" || r.children.length === 0)).toBe(true);
});

test("a subagent's work nests under the call that spawned it", () => {
  const rows = buildRows([
    tool("Task", "Trace billable gate"),
    tool("Read", "services.py", { agent_id: "a1", agent_type: "subagent" }),
    tool("Bash", "grep -rn foo", { agent_id: "a1", agent_type: "subagent" }),
    tool("Edit", "views.py"),
  ]);
  // Two top-level rows: the spawn and the main thread's own edit. The
  // subagent's two calls are inside the spawn, not beside it.
  expect(rows).toHaveLength(2);
  expect(rows[0].kind === "tool" && rows[0].e.tool).toBe("Task");
  expect(rows[0].kind === "tool" && rows[0].children.map((c) => c.tool)).toEqual(["Read", "Bash"]);
  expect(rows[1].kind === "tool" && rows[1].e.tool).toBe("Edit");
});

test("concurrent subagents land in the order they were spawned", () => {
  const rows = buildRows([
    tool("Task", "first"),
    tool("Task", "second"),
    tool("Read", "one.ts", { agent_id: "a1" }),
    tool("Read", "two.ts", { agent_id: "a2" }),
    tool("Bash", "echo 1", { agent_id: "a1" }),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0].kind === "tool" && rows[0].children.map((c) => c.target)).toEqual(["one.ts", "echo 1"]);
  expect(rows[1].kind === "tool" && rows[1].children.map((c) => c.target)).toEqual(["two.ts"]);
});

test("a subagent whose spawn we never saw still gets a row of its own", () => {
  // What you get attaching to a session already in flight, or when the spawn
  // has aged out of the window. The work must not scatter through the thread.
  const rows = buildRows([
    tool("Read", "a.ts", { agent_id: "ghost", agent_type: "Explore" }),
    tool("Bash", "ls", { agent_id: "ghost", agent_type: "Explore" }),
    tool("Edit", "b.ts"),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0].kind === "tool" && rows[0].e.tool).toBe("Explore");
  expect(rows[0].kind === "tool" && rows[0].children).toHaveLength(2);
  expect(rows[1].kind === "tool" && rows[1].e.tool).toBe("Edit");
});

test("a subagent's own messages nest with its tools rather than becoming turns", () => {
  const rows = buildRows([
    tool("Task", "go"),
    msg("I'll read the manager.", { agent_id: "a1" }),
    tool("Read", "managers.py", { agent_id: "a1" }),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind === "tool" && rows[0].children.map((c) => c.kind)).toEqual(["message", "tool"]);
});

test("a non-spawning tool never adopts a subagent", () => {
  // Only Task/Agent/Explore start one. A Read that happens to precede a
  // sidechain must not swallow it.
  const rows = buildRows([
    tool("Read", "a.ts"),
    tool("Bash", "ls", { agent_id: "a1", agent_type: "subagent" }),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0].kind === "tool" && rows[0].children).toHaveLength(0);
  expect(rows[1].kind === "tool" && rows[1].e.tool).toBe("subagent");
});

test("a row keeps its key when the server's window slides", () => {
  // The session response carries the newest N runs, so every new tool call
  // pushes the oldest one out and moves everything else along by one. Keys used
  // to be that position, which told React the whole conversation had changed:
  // a live session tore down and rebuilt hundreds of rows every poll, losing
  // any row the reader had opened. The rows themselves are what must be named.
  const a = tool("Read", "a.ts", { tool_use_id: "u1" });
  const b = tool("Bash", "ls", { tool_use_id: "u2" });
  const c = tool("Edit", "b.ts", { tool_use_id: "u3" });
  const d = tool("Bash", "git status", { tool_use_id: "u4" });

  const before = buildRows([a, b, c]);
  const after = buildRows([b, c, d]); // `a` aged out, `d` arrived
  expect(before.slice(1).map((r) => r.key)).toEqual(after.slice(0, 2).map((r) => r.key));
});

test("indistinguishable rows still get distinct keys", () => {
  // Same timestamp, same tool, same target, and no tool_use_id to tell them
  // apart. They still need one key each, and the same key on each rebuild.
  const twin = (): TimelineEntry => ({ kind: "tool", ts: 500, tool: "Bash", target: "ls" });
  const keys = buildRows([twin(), twin(), twin()]).map((r) => r.key);
  expect(new Set(keys).size).toBe(3);
  expect(buildRows([twin(), twin(), twin()]).map((r) => r.key)).toEqual(keys);
});
