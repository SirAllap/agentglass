// The events table stored two things twice (see src/payloadslim.ts): a tool's
// input on its PreToolUse row and again on its PostToolUse row, and a reply's
// `usage.iterations`, one entry that repeats the usage it sits in. New rows are
// written without the repeats; old rows lose them in a resumable pass. What has
// to hold either way: every reader shows the same thing — the feed replay
// (getRecent plus the feed's labels), the diff list, the session detail and the
// spend totals — and the payload bytes go down.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detail } from "../../web/src/lib/labels.ts";
import { slimToolInput, dropRepeatedIterations, slimToolResponse, slimForInsert, BASH_CONTENT_CAP, RESPONSE_CAP } from "../src/payloadslim.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-slim-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB ??= join(dir, "slim.db");
process.env.AGENTGLASS_ROOT ??= ROOT;
process.env.XDG_CONFIG_HOME ??= dir;

let db: typeof import("../src/db.ts");
let ingest: typeof import("../src/ingest.ts");
let lantern: typeof import("../src/lantern.ts");
beforeAll(async () => {
  db = await import("../src/db.ts");
  ingest = await import("../src/ingest.ts");
  lantern = await import("../src/lantern.ts");
});

/* ── a fixture shaped like the real table ─────────────────────────────────── */

// Deterministic filler, so a byte count is the same every run.
const text = (n: number, seed: number) => {
  let s = "", x = seed;
  while (s.length < n) { x = (x * 1103515245 + 12345) % 2147483648; s += "lorem ipsum dolor sit amet consectetur "[x % 39]; }
  return s;
};
const usage = (k: number) => {
  const base = { input_tokens: 2, cache_creation_input_tokens: 300 + k, cache_read_input_tokens: 29_000 + k, output_tokens: 60 + k,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 + k } };
  return {
    ...base, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard", inference_geo: "global",
    iterations: [{ input_tokens: 2, output_tokens: 60 + k, cache_read_input_tokens: 29_000 + k, cache_creation_input_tokens: 300 + k,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 + k }, type: "message" }],
  };
};

type Call = { tool: string; input: Record<string, unknown>; response: Record<string, unknown> };
function call(i: number): Call {
  const f = `${ROOT}/src/mod${i % 7}.ts`;
  switch (i % 6) {
    case 0: return { tool: "Bash", input: { command: `bun test test/thing${i}.test.ts 2>&1 | tail -40`, description: "Run the thing tests" },
      response: { stdout: text(1500, i), stderr: "", interrupted: false } };
    case 1: return { tool: "Read", input: { file_path: f }, response: { type: "text", file: { filePath: f, content: text(4000, i) } } };
    case 2: { const o = text(600, i), n = text(640, i + 1);
      return { tool: "Edit", input: { file_path: f, old_string: o, new_string: n, replace_all: false },
        response: { filePath: f, oldString: o, newString: n, originalFile: text(4000, i + 2),
          structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ["-" + o.slice(0, 80), "+" + n.slice(0, 80)] }] } }; }
    case 3: { const c = text(3000, i);
      return { tool: "Write", input: { file_path: f, content: c }, response: { type: "create", filePath: f, content: c, structuredPatch: [] } }; }
    case 4: return { tool: "Task", input: { description: "Find the readers", prompt: text(1500, i), subagent_type: "Explore" },
      response: { content: [{ type: "text", text: text(800, i) }] } };
    default: return { tool: "TodoWrite", input: { todos: [0, 1, 2, 3].map((t) => ({ content: text(80, i + t), status: "pending", activeForm: text(60, i + t) })) },
      response: { oldTodos: [], newTodos: [] } };
  }
}

const CALLS = 120;
const sid = (tag: string) => `slim-${tag}`;
/** The fixture as /ingest bodies, in order: per call a Pre (with the reply's usage on it), a Post; a Stop every 4 calls. */
function bodies(session: string, t0: number) {
  const out: any[] = [];
  for (let i = 0; i < CALLS; i++) {
    const c = call(i), id = `toolu_${session}_${i}`, ts = t0 + i * 1000;
    const common = { cwd: ROOT, project_path: ROOT, session_id: session, tool_name: c.tool, tool_use_id: id };
    out.push({ source_app: "proj", session_id: session, hook_event_type: "PreToolUse", timestamp: ts, model_name: "claude-sonnet-5-5",
      payload: { ...common, hook_event_name: "PreToolUse", tool_input: structuredClone(c.input), usage: usage(i) } });
    out.push({ source_app: "proj", session_id: session, hook_event_type: "PostToolUse", timestamp: ts + 400,
      payload: { ...common, hook_event_name: "PostToolUse", tool_input: structuredClone(c.input), tool_response: c.response } });
    if (i % 4 === 3) out.push({ source_app: "proj", session_id: session, hook_event_type: "Stop", timestamp: ts + 600, model_name: "claude-sonnet-5-5",
      payload: { cwd: ROOT, project_path: ROOT, last_assistant_message: text(300, i), usage: usage(1000 + i) } });
  }
  return out;
}

/** Store rows the way builds before this one did: payload whole, no slimming. */
function insertOld(session: string, t0: number): { lo: number; hi: number } {
  let lo = Infinity, hi = 0;
  for (const b of bodies(session, t0)) {
    const n = ingest.normalize(structuredClone(b));
    // normalize now drops the copied iterations; put the old shape back.
    if (b.payload.usage) (n.payload as any).usage = structuredClone(b.payload.usage);
    const r = db.db.query<{ id: number }, any[]>(
      `INSERT INTO events (source_app, session_id, hook_event_type, tool_name, tool_use_id, model_name, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, cost_usd, payload, timestamp, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
      n.source_app, n.session_id, n.hook_event_type, n.tool_name, n.tool_use_id, n.model_name,
      n.usage.input_tokens ?? 0, n.usage.output_tokens ?? 0, n.usage.cache_creation_tokens ?? 0, n.usage.cache_read_tokens ?? 0,
      (n.usage.output_tokens ?? 0) * 1e-6, JSON.stringify(n.payload), n.timestamp, n.hook_event_type === "PostToolUse" ? 400 : null)!;
    lo = Math.min(lo, r.id); hi = Math.max(hi, r.id);
  }
  return { lo, hi };
}

const bytes = (session: string) =>
  (db.db.query<{ b: number }, [string]>(`SELECT SUM(length(payload)) AS b FROM events WHERE session_id = ?`).get(session)!).b;

/** Everything a person sees of the session, with the row ids taken out. */
function seen(session: string) {
  const recent = db.getRecent(5000).filter((e) => e.session_id === session);
  const spend = db.db.query<any, [string]>(
    `SELECT SUM(cost_usd) c, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_creation_tokens) cw, SUM(cache_read_tokens) cr FROM events WHERE session_id = ?`).get(session);
  const detailOf = db.getSession(session) as any;
  const changes = db.getChanges(200, session).map(({ id, ...c }: any) => c);
  return {
    feed: recent.map((e) => `${e.hook_event_type}|${e.tool_name}|${detail(e)}|${lantern.toolWhat(e.tool_name ?? "", (e.payload as any)?.tool_input)}`),
    // A Post's whole payload is what the session view and the diff read.
    posts: recent.filter((e) => e.hook_event_type === "PostToolUse").map((e) => JSON.stringify(e.payload)),
    changes, spend,
    session: JSON.stringify(detailOf, (k, v) => (k === "id" || k === "change" ? undefined : v)),
  };
}

describe("payloadslim, the pure parts", () => {
  test("a Pre keeps what its readers read and loses the big fields", () => {
    const s = slimToolInput({ file_path: "/a/b.ts", old_string: "x".repeat(900), new_string: "y", replace_all: false })!;
    expect(s).toEqual({ file_path: "/a/b.ts", old_string: "x".repeat(200), new_string: "y", replace_all: false });
    expect(slimToolInput({ command: "c".repeat(5000), description: "d" })).toBeNull(); // nothing to drop
    expect(slimToolInput({ todos: [{ content: "a" }] })).toEqual({});
  });
  test("iterations go only when they are one copy of the usage", () => {
    const one = { usage: usage(1) };
    expect(dropRepeatedIterations(one)).toBe(true);
    expect("iterations" in one.usage).toBe(false);
    const two = { usage: { ...usage(1), iterations: [usage(1).iterations[0], { ...usage(1).iterations[0], output_tokens: 5 }] } };
    expect(dropRepeatedIterations(two)).toBe(false);
    const differs = { usage: { ...usage(1), iterations: [{ ...usage(1).iterations[0], output_tokens: 9 }] } };
    expect(dropRepeatedIterations(differs)).toBe(false);
  });
});

describe("the events table without its repeats", () => {
  test("the pass over old rows changes no reader and cuts the bytes", () => {
    const s = sid("old");
    const { lo, hi } = insertOld(s, Date.now() - 3 * 3_600_000);
    const before = seen(s), b0 = bytes(s);
    db.__setSlimPass(lo - 1, hi);
    let steps = 0;
    while (db.slimOldEventsStep(50)) steps++;
    expect(steps).toBeGreaterThan(3); // it really ran in windows
    expect(db.slimOldEventsStep(50)).toBe(false); // and stays done
    const after = seen(s), b1 = bytes(s);
    expect(after).toEqual(before);
    console.log(`fixture ${CALLS} calls: payload ${b0} -> ${b1} bytes (-${b0 - b1}, ${((1 - b1 / b0) * 100).toFixed(1)}%)`);
    expect(b1).toBeLessThan(b0);
    // Every Pre that had something to drop is marked; no Post is touched.
    const pre = db.db.query<{ n: number; slim: number }, [string]>(
      `SELECT COUNT(*) n, SUM(json_extract(payload,'$.tool_input_slim') IS 1) slim FROM events WHERE session_id = ? AND hook_event_type = 'PreToolUse'`).get(s)!;
    expect(pre.slim).toBe((CALLS / 6) * 4); // Bash and Read inputs are already small
    expect(db.db.query(`SELECT 1 FROM events WHERE session_id = ? AND instr(payload, '"iterations":[') > 0`).get(s)).toBeNull();
  });

  test("a resumed pass picks up at its mark", () => {
    const s = sid("resume");
    const { lo, hi } = insertOld(s, Date.now() - 2 * 3_600_000);
    db.__setSlimPass(lo - 1, hi);
    db.slimOldEventsStep(40); // one window, then "quit"
    const mark = db.db.query<{ last_id: number }, []>(`SELECT last_id FROM events_slim_pass WHERE k = 1`).get()!.last_id;
    expect(mark).toBe(lo - 1 + 40);
    while (db.slimOldEventsStep(40)) { /* the next boot */ }
    expect(db.db.query(`SELECT 1 FROM events WHERE session_id = ? AND instr(payload, '"iterations":[') > 0`).get(s)).toBeNull();
  });

  test("new rows are written slim, and read the same as old rows after the pass", () => {
    const old = sid("old"), live = sid("live");
    const t0 = Date.now() - 3_600_000;
    for (const b of bodies(live, t0)) db.insertEvent(ingest.normalize(b));
    const a = seen(old), b = seen(live);
    // Same calls, same text: only the session id differs.
    const norm = (x: ReturnType<typeof seen>) => JSON.parse(JSON.stringify(x.feed).replaceAll(old, "S").replaceAll(live, "S"));
    expect(norm(b)).toEqual(norm(a));
    expect(b.changes.length).toBe(a.changes.length);
    expect(b.changes.map((c: any) => c.file_path)).toEqual(a.changes.map((c: any) => c.file_path));
    // The live Post keeps the whole input; the Pre is the short copy.
    const pre = db.db.query<{ p: string }, [string]>(`SELECT payload p FROM events WHERE session_id = ? AND hook_event_type = 'PreToolUse' AND tool_name = 'Write' LIMIT 1`).get(live)!;
    const post = db.db.query<{ p: string }, [string]>(`SELECT payload p FROM events WHERE session_id = ? AND hook_event_type = 'PostToolUse' AND tool_name = 'Write' LIMIT 1`).get(live)!;
    expect(JSON.parse(pre.p).tool_input_slim).toBe(true);
    expect(JSON.parse(pre.p).tool_input.content.length).toBe(200);
    expect(JSON.parse(post.p).tool_input.content.length).toBe(3000);
    console.log(`live ${CALLS} calls: payload ${bytes(live)} bytes`);
  });

  test("a Post whose input differs from its Pre leaves the Pre whole", () => {
    const s = sid("differs"), t = Date.now() - 1_800_000, big = "z".repeat(1000);
    const base = { source_app: "proj", session_id: s, tool_name: "Write", timestamp: t } as any;
    db.insertEvent(ingest.normalize({ ...base, hook_event_type: "PreToolUse", payload: { tool_use_id: "tu_d", tool_name: "Write", tool_input: { file_path: "/x", content: big } } }));
    db.insertEvent(ingest.normalize({ ...base, hook_event_type: "PostToolUse", timestamp: t + 10, payload: { tool_use_id: "tu_d", tool_name: "Write", tool_input: { file_path: "/x", content: big + "!" } } }));
    const pre = db.db.query<{ p: string }, [string]>(`SELECT payload p FROM events WHERE session_id = ? AND hook_event_type = 'PreToolUse'`).get(s)!;
    expect(JSON.parse(pre.p).tool_input.content).toBe(big);
  });
});

describe("the slim pass with a second server and with failures", () => {
  test("the mark is read inside the write lock: a second server's step is not redone", () => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const s = sid("twoservers");
    const { lo, hi } = insertOld(s, Date.now() - 4 * 3_600_000);
    db.__setSlimPass(lo - 1, hi);
    const other = new Database(db.db.filename);
    const mark = () => db.db.query<{ last_id: number }, []>(`SELECT last_id FROM events_slim_pass WHERE k = 1`).get()!.last_id;
    db.db.exec("PRAGMA busy_timeout = 0;");
    try {
      // The other server is in the middle of its step: it holds the write lock
      // and has moved the mark 80 on, not yet committed.
      other.exec("BEGIN IMMEDIATE");
      other.run(`UPDATE events_slim_pass SET last_id = ? WHERE k = 1`, [lo - 1 + 80]);
      expect(() => db.slimOldEventsStep(40)).toThrow(); // waits for the lock, reads nothing
      expect(mark()).toBe(lo - 1); // this connection still sees the committed mark
      other.exec("COMMIT");
      // Once the lock is free, the step starts from the other server's mark.
      db.slimOldEventsStep(40);
      expect(mark()).toBe(lo - 1 + 120);
    } finally {
      db.db.exec("PRAGMA busy_timeout = 5000;");
      try { other.exec("ROLLBACK"); } catch { /* committed */ }
      other.close();
    }
    while (db.slimOldEventsStep(40)) { /* finish */ }
  });

  test("a failing step is said once and tried again later, backing off", async () => {
    const warn = console.warn, said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.join(" ")); };
    const at: number[] = [];
    let calls = 0;
    try {
      db.startSlimOldEvents(0, 1, 20, 80, () => {
        at.push(performance.now());
        if (++calls <= 3) throw new Error("database is locked");
        return false;
      });
      const t0 = performance.now();
      while (calls < 4 && performance.now() - t0 < 3000) await Bun.sleep(5);
    } finally { console.warn = warn; }
    expect(calls).toBe(4);
    // Only the slim pass's own line counts: console.warn is the whole process's, and the stall watchdog writes there too on a loaded runner.
    const mine = said.filter((m) => m.startsWith("[db] events slim pass step failed"));
    expect(mine.length).toBe(1);
    expect(mine[0]).toContain("database is locked");
    // Waits of about 20, 40 and 80 ms between the tries.
    expect(at[2] - at[1]).toBeGreaterThan(at[1] - at[0]);
    expect(at[3] - at[2]).toBeGreaterThanOrEqual(70);
  });
});

describe("a tool's answer cut to what is read", () => {
  test("originalFile goes, long strings keep their head, short answers are left alone", () => {
    const p = { tool_response: { filePath: "/a.ts", originalFile: "o".repeat(9000), structuredPatch: [{ lines: ["-a", "+b"] }] } };
    const s = slimToolResponse(p)!;
    expect(s.tool_response).toEqual({ filePath: "/a.ts", structuredPatch: [{ lines: ["-a", "+b"] }] });
    expect("originalFile" in p.tool_response).toBe(true); // never mutates
    const r = slimToolResponse({ tool_response: { file: { filePath: "/a.ts", content: "c".repeat(RESPONSE_CAP + 50) } } })!;
    expect((r.tool_response as any).file.content).toBe("c".repeat(RESPONSE_CAP) + "…[+50 chars]");
    expect(slimToolResponse({ tool_response: { stdout: "ok", stderr: "" } })).toBeNull();
    expect(slimToolResponse({ tool_input: { content: "x".repeat(9000) } })).toBeNull(); // input is not touched
  });

  test("the pass over old rows keeps the feed, the diffs and the session, and cuts the bytes", () => {
    const s = sid("resp");
    const { lo, hi } = insertOld(s, Date.now() - 4 * 3_600_000);
    const strip = (x: ReturnType<typeof seen>) => ({ feed: x.feed, changes: x.changes, spend: x.spend });
    const before = seen(s), b0 = bytes(s);
    db.__setRespPass(lo - 1, hi);
    db.slimOldResponsesStep(40); // one window, then "quit"
    expect(db.db.query<{ last_id: number }, []>(`SELECT last_id FROM events_resp_pass WHERE k = 1`).get()!.last_id).toBe(lo - 1 + 40);
    while (db.slimOldResponsesStep(40)) { /* the next boot */ }
    expect(db.slimOldResponsesStep(40)).toBe(false);
    const after = seen(s), b1 = bytes(s);
    expect(strip(after)).toEqual(strip(before));
    expect(db.db.query(`SELECT 1 FROM events WHERE session_id = ? AND instr(payload, '"originalFile"') > 0`).get(s)).toBeNull();
    console.log(`resp pass ${CALLS} calls: payload ${b0} -> ${b1} bytes (-${((1 - b1 / b0) * 100).toFixed(1)}%)`);
    expect(b1).toBeLessThan(b0);
  });

  test("new rows are stored with the answer cut", () => {
    const s = sid("resp-live"), t = Date.now() - 1_200_000;
    db.insertEvent(ingest.normalize({ source_app: "proj", session_id: s, hook_event_type: "PostToolUse", tool_name: "Edit", timestamp: t,
      payload: { tool_use_id: "tu_rl", tool_name: "Edit", tool_input: { file_path: "/x", old_string: "a", new_string: "b" },
        tool_response: { filePath: "/x", originalFile: "o".repeat(20_000), structuredPatch: [] } } } as any));
    const p = JSON.parse(db.db.query<{ p: string }, [string]>(`SELECT payload p FROM events WHERE session_id = ?`).get(s)!.p);
    expect(p.tool_response).toEqual({ filePath: "/x", structuredPatch: [] });
    expect(p.tool_input.old_string).toBe("a");
  });
});

describe("cut at insert: Bash answer head, Stop usage", () => {
  test("a long Bash content keeps its head and a tail marker; short, other tools, other keys stay", () => {
    const p = { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { content: "b".repeat(BASH_CONTENT_CAP + 30), stderr: "e" } };
    const s = slimForInsert(p, "PostToolUse")!;
    expect((s.tool_response as any).content).toBe("b".repeat(BASH_CONTENT_CAP) + "…[+30 chars]");
    expect((s.tool_response as any).stderr).toBe("e");
    expect((p.tool_response as any).content.length).toBe(BASH_CONTENT_CAP + 30); // never mutates
    expect(slimForInsert({ tool_name: "Bash", tool_response: { content: "ok" } }, "PostToolUse")).toBeNull();
    expect(slimForInsert({ tool_name: "Read", tool_response: { content: "r".repeat(3000) } }, "PostToolUse")).toBeNull();
  });
  test("Stop drops usage and keeps the rest; other events keep usage", () => {
    const s = slimForInsert({ last_assistant_message: "hi", usage: { input_tokens: 5 } }, "Stop")!;
    expect(s).toEqual({ last_assistant_message: "hi" });
    expect(slimForInsert({ usage: { input_tokens: 5 } }, "UserPromptSubmit")).toBeNull();
  });
});
