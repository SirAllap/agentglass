// Events past the hot window lose what nothing reads (see slimColdEvent in
// src/payloadslim.ts): a long command, a long Bash answer, `usage`, a long Task
// prompt. They keep what a reader asks for. The cut runs in slices, each its own
// transaction, and stops at the first row still inside the window.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH_CONTENT_CAP, COLD_COMMAND_CAP, slimColdEvent } from "../src/payloadslim.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cold-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "cold.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME ??= dir;

let db: typeof import("../src/db.ts");
beforeAll(async () => { db = await import("../src/db.ts"); });

const long = (n: number) => "x".repeat(n);

describe("slimColdEvent", () => {
  test("cuts a long Bash command on the Pre and the Post, keeps a short one", () => {
    const pre = slimColdEvent({ tool_input: { command: long(3000), description: "run it" } }, "PreToolUse", "Bash") as any;
    expect(pre.tool_input.command.length).toBeLessThan(COLD_COMMAND_CAP + 30);
    expect(pre.tool_input.command).toContain("…[+2500 chars]");
    expect(pre.tool_input.description).toBe("run it");
    const post = slimColdEvent({ tool_input: { command: long(3000) } }, "PostToolUse", "Bash") as any;
    expect(post.tool_input.command.startsWith("x".repeat(COLD_COMMAND_CAP))).toBe(true);
    expect(slimColdEvent({ tool_input: { command: "ls -la" } }, "PostToolUse", "Bash")).toBeNull();
  });
  test("cuts a Bash answer to its head, leaves another tool's answer", () => {
    const r = slimColdEvent({ tool_response: { content: long(5000), is_error: false } }, "PostToolUse", "Bash") as any;
    expect(r.tool_response.content.length).toBeLessThan(BASH_CONTENT_CAP + 30);
    expect(r.tool_response.is_error).toBe(false);
    expect(slimColdEvent({ tool_response: { content: long(5000) } }, "PostToolUse", "Read")).toBeNull();
  });
  test("drops usage on any row", () => {
    const r = slimColdEvent({ usage: { input_tokens: 2 }, last_assistant_message: "done" }, "Stop", null) as any;
    expect("usage" in r).toBe(false);
    expect(r.last_assistant_message).toBe("done");
  });
  test("never touches a diff tool's input or answer, nor a prompt or last message", () => {
    const w = { tool_input: { file_path: "/code/orbit/a.ts", content: long(9000) }, tool_response: { filePath: "/code/orbit/a.ts", structuredPatch: [{ lines: ["+a"] }] } };
    expect(slimColdEvent(w, "PostToolUse", "Write")).toBeNull();
    expect(slimColdEvent({ prompt: long(9000) }, "UserPromptSubmit", null)).toBeNull();
    expect(slimColdEvent({ last_assistant_message: long(9000) }, "Stop", null)).toBeNull();
  });
  test("cuts a long Task prompt but keeps the fields Lantern reads", () => {
    const r = slimColdEvent({ tool_input: { prompt: long(900), subagent_type: "Explore", description: "look" } }, "PostToolUse", "Task") as any;
    expect(r.tool_input.prompt.length).toBe(200);
    expect(r.tool_input.subagent_type).toBe("Explore");
  });
  test("a second pass leaves an already cut string alone, count included", () => {
    const first = slimColdEvent({ tool_input: { command: long(3000) } }, "PreToolUse", "Bash") as any;
    expect(slimColdEvent(first, "PreToolUse", "Bash")).toBeNull();
    const bash = slimColdEvent({ tool_response: { content: long(5000) } }, "PostToolUse", "Bash") as any;
    expect(slimColdEvent(bash, "PostToolUse", "Bash")).toBeNull();
  });
  test("does not mutate its argument", () => {
    const p = { usage: { a: 1 }, tool_input: { command: long(900) } };
    slimColdEvent(p, "PreToolUse", "Bash");
    expect(p.usage).toEqual({ a: 1 });
    expect(p.tool_input.command.length).toBe(900);
  });
});

describe("slimColdEventsStep", () => {
  test("slices stop at the hot edge, rewrite only old rows, and a rerun changes nothing", () => {
    const now = Date.now();
    // The walk starts at the saved cursor, and a database shared with other files may hold a
    // recent row past it, which is the hot edge: start from the newest row there is.
    db.db.run("INSERT INTO events_cold_pass (k, last_id) VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM events)) ON CONFLICT(k) DO UPDATE SET last_id = excluded.last_id");
    const ins = db.db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, payload, timestamp) VALUES ('claude-code', ?, ?, 'Bash', ?, ?)");
    const body = (n: number) => JSON.stringify({ project_path: "/code/orbit/p", usage: { input_tokens: 5 }, tool_input: { command: long(n) }, tool_response: { content: long(n) } });
    const ids: number[] = [];
    db.db.transaction(() => {
      for (let i = 0; i < 25; i++) ids.push(Number(ins.run(`cold${i % 3}`, "PostToolUse", body(4000), now - 3 * 86_400_000 + i).lastInsertRowid));
      for (let i = 0; i < 5; i++) ids.push(Number(ins.run("hot", "PostToolUse", body(4000), now - 1000 + i).lastInsertRowid));
    })();
    const len = (id: number) => (db.db.query("SELECT length(payload) n FROM events WHERE id = ?").get(id) as { n: number }).n;
    const before = ids.map(len);
    let slices = 0, longest = 0;
    for (;;) {
      const t = performance.now();
      const more = db.slimColdEventsStep(4, now);
      longest = Math.max(longest, performance.now() - t); slices++;
      if (!more) break;
    }
    expect(slices).toBeGreaterThanOrEqual(7);
    const after = ids.map(len);
    expect(after.slice(0, 25).every((n, i) => n < before[i] / 2)).toBe(true);
    expect(after.slice(25)).toEqual(before.slice(25));
    const row = db.db.query("SELECT payload FROM events WHERE id = ?").get(ids[0]) as { payload: string };
    const p = JSON.parse(row.payload);
    expect(p.project_path).toBe("/code/orbit/p");
    expect("usage" in p).toBe(false);
    // Caught up: nothing is owed, nothing is rewritten.
    expect(db.slimColdEventsStep(4, now)).toBe(false);
    expect(ids.map(len)).toEqual(after);
    expect(longest).toBeLessThan(1000);
  });
});

describe("slice byte budget", () => {
  test("a slice stops before the row that would pass the budget, but always takes one row", () => {
    const now = Date.now();
    db.db.run("DELETE FROM events"); db.db.run("DELETE FROM events_cold_pass");
    const ins = db.db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, payload, timestamp) VALUES ('claude-code', 'bud', 'PostToolUse', 'Bash', ?, ?)");
    const ids: number[] = [];
    db.db.transaction(() => {
      for (let i = 0; i < 5; i++) ids.push(Number(ins.run(JSON.stringify({ tool_input: { command: "x".repeat(150_000) } }), now - 3 * 86_400_000 + i).lastInsertRowid));
    })();
    // 150 KB rows, 400 KB budget: two rows fit (300 KB), the third would reach 450 KB.
    expect(db.slimColdEventsStep(200, now)).toBe(true);
    const last = (db.db.query("SELECT last_id FROM events_cold_pass WHERE k = 1").get() as { last_id: number }).last_id;
    expect(last).toBe(ids[1]);
  });
});

describe("fixture database of invented rows", () => {
  test("a few thousand rows: bytes drop, slices stay short, the loop is freed between them", async () => {
    const now = Date.now();
    db.db.run("DELETE FROM events"); db.db.run("DELETE FROM events_cold_pass");
    const ins = db.db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, payload, timestamp) VALUES ('claude-code', ?, ?, ?, ?, ?)");
    const sizes = [200, 1500, 6000, 20_000, 64_000];
    const total = () => (db.db.query("SELECT COALESCE(SUM(length(payload)),0) n FROM events WHERE session_id LIKE 'fx%'").get() as { n: number }).n;
    db.db.transaction(() => {
      for (let i = 0; i < 4000; i++) {
        const n = sizes[i % sizes.length];
        const hot = i >= 3600;
        const tool = i % 4 === 0 ? "Write" : "Bash";
        const payload = tool === "Write"
          ? { tool_input: { file_path: "/code/orbit/a.ts", content: long(n) } }
          : { usage: { input_tokens: 9 }, tool_input: { command: long(n) }, tool_response: { content: long(n) } };
        ins.run(`fx${i % 7}`, "PostToolUse", tool, JSON.stringify(payload), hot ? now - 1000 + i : now - 4 * 86_400_000 + i);
      }
    })();
    const before = total();
    const { slimColdEventsStep } = db;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let longest = 0, slices = 0;
    for (;;) {
      const t = performance.now();
      const more = slimColdEventsStep(db.COLD_SLICE, now);
      longest = Math.max(longest, performance.now() - t); slices++;
      if (!more) break;
      await new Promise<void>((r) => setImmediate(r));
    }
    clearInterval(timer);
    const after = total();
    console.log(`fixture bytes before=${before} after=${after} slices=${slices} longest_slice_ms=${longest.toFixed(1)}`);
    expect(after).toBeLessThan(before * 0.7);
    expect(slices).toBeGreaterThan(5);
    expect(longest).toBeLessThan(500);
  });
});
