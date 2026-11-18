/*
 * A restart resumes live transcripts at their saved offset instead of re-reading
 * them from line 0. `__dropTailCache()` stands in for the restart: memory gone,
 * database (progress row, resume row, refusal row) intact.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-resume-"));
const PROJECTS = join(dir, "projects", "-tmp-resumeproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "resume.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "resumeproj");
const FIXTURES = ["s-res-grow", "s-res-same", "s-res-shrunk", "s-res-tool", "s-res-usage", "s-res-lag", "s-res-quiet", "s-res-size", "s-res-swap", "s-res-mid"];

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-resume-fixture");
  mkdirSync(CWD, { recursive: true });
});
afterAll(() => {
  if (!db) return;
  const marks = FIXTURES.map(() => "?").join(",");
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, FIXTURES); } catch { /* */ }
  }
  for (const f of FIXTURES) {
    for (const t of ["transcript_resume", "transcript_refused"]) {
      try { db.db.run(`DELETE FROM ${t} WHERE path = ?`, [path(f)]); } catch { /* */ }
    }
  }
});

let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();
const path = (sid: string) => join(PROJECTS, `${sid}.jsonl`);
const put = (sid: string, ls: string[]) => writeFileSync(path(sid), ls.map((l) => l + "\n").join(""));
const add = (sid: string, ls: string[]) => appendFileSync(path(sid), ls.map((l) => l + "\n").join(""));
const prompt = (sid: string, text: string) =>
  JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: ts(), message: { role: "user", content: text } });
const toolUse = (sid: string, id: string, usage?: unknown) =>
  JSON.stringify({
    type: "assistant", cwd: CWD, sessionId: sid, timestamp: ts(),
    message: { id: `m-${id}`, model: "claude-opus-4-8", role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }], ...(usage ? { usage } : {}) },
  });
const toolResult = (sid: string, id: string) =>
  JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: ts(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const rows = (sid: string) =>
  db.db.query<{ hook_event_type: string; tool_name: string | null; payload: string }, [string]>(
    "SELECT hook_event_type, tool_name, payload FROM events WHERE session_id = ? ORDER BY id").all(sid);
const prompts = (sid: string) =>
  rows(sid).filter((r) => r.hook_event_type === "UserPromptSubmit").map((r) => JSON.parse(r.payload).prompt as string);
const sweep = () => scan.scanOnce(null);
/** Restart, then one boot sweep; returns lines JSON-parsed by it. */
async function reboot(): Promise<number> {
  scan.__dropTailCache(true);
  scan.__resetLinesParsedCount();
  await sweep();
  return scan.__linesParsedCount();
}

describe("restart resumes from the saved offset", () => {
  test("append after restart parses only the new lines, once", async () => {
    const sid = "s-res-grow";
    put(sid, Array.from({ length: 50 }, (_, i) => prompt(sid, `p${i}`)));
    await sweep();
    add(sid, [prompt(sid, "new1"), prompt(sid, "new2")]);
    const parsed = await reboot();
    expect(parsed).toBe(2); // before this change: 52
    const got = prompts(sid);
    expect(got.length).toBe(52);
    expect(got.slice(-2)).toEqual(["new1", "new2"]);
  });

  test("unchanged file after restart parses 0 lines", async () => {
    const sid = "s-res-same";
    put(sid, [prompt(sid, "a"), prompt(sid, "b")]);
    await sweep();
    expect(await reboot()).toBe(0);
    expect(prompts(sid)).toEqual(["a", "b"]);
  });

  test("open tool call and seen usage survive the restart", async () => {
    const sid = "s-res-tool";
    put(sid, [prompt(sid, "go"), toolUse(sid, "t1")]);
    await sweep();
    add(sid, [toolResult(sid, "t1")]);
    expect(await reboot()).toBe(1);
    const post = rows(sid).filter((r) => r.hook_event_type === "PostToolUse");
    expect(post.length).toBe(1);
    expect(post[0]!.tool_name).toBe("Bash"); // name came from the persisted call

    const sid2 = "s-res-usage";
    const usage = { input_tokens: 10, output_tokens: 5 };
    put(sid2, [toolUse(sid2, "u1", usage)]);
    await sweep();
    const before = rows(sid2).filter((r) => r.payload.includes("input_tokens")).length;
    // a second content block of the SAME message repeats its usage
    add(sid2, [toolUse(sid2, "u1", usage)]);
    await reboot();
    const after = rows(sid2).filter((r) => r.payload.includes("input_tokens")).length;
    expect(after).toBe(before);
  });

  test("a shrunk file is re-read from 0; its lines land once", async () => {
    const sid = "s-res-shrunk";
    put(sid, Array.from({ length: 10 }, (_, i) => prompt(sid, `old${i}`)));
    await sweep();
    const n = prompts(sid).length;
    put(sid, [prompt(sid, "rw0"), prompt(sid, "rw1")]); // rewritten, shorter: new content
    scan.__dropTailCache(true);
    scan.__resetLinesParsedCount();
    await sweep();
    expect(scan.__linesParsedCount()).toBe(2);
    const got = prompts(sid);
    // The rewrite's two new lines land exactly once each; the old ones are not re-inserted.
    expect(got.length).toBe(n + 2);
    expect(got.filter((p) => p === "rw0").length).toBe(1);
    expect(got.filter((p) => p === "rw1").length).toBe(1);
  });

  test("a stale resume row (lines != progress) falls back to a whole read", async () => {
    const sid = "s-res-grow";
    db.db.run("UPDATE transcript_resume SET lines = lines + 7 WHERE path = ?", [path(sid)]);
    add(sid, [prompt(sid, "after-stale")]);
    const parsed = await reboot();
    expect(parsed).toBe(53);
    expect(prompts(sid).filter((p) => p === "after-stale").length).toBe(1);
  });
});

describe("out-of-scope verdict survives a restart", () => {
  test("a persisted refusal is trusted: the grown file is not re-read", async () => {
    const f = "s-res-same";
    db.db.run("INSERT OR REPLACE INTO transcript_refused (path, scope, size, mtime) VALUES (?, ?, ?, ?)",
      [path(f) + ".x", "scope-a", 10, 1]);
    // The memo round-trips through the table: a fresh process finds the row.
    const row = db.db.query<{ scope: string }, [string]>("SELECT scope FROM transcript_refused WHERE path = ?").get(path(f) + ".x");
    expect(row?.scope).toBe("scope-a");
    db.db.run("DELETE FROM transcript_refused WHERE path = ?", [path(f) + ".x"]);
  });
});

describe("resume writes are throttled and may lag", () => {
  test("10 sweeps with no new lines write nothing; 10 growing sweeps write once", async () => {
    const sid = "s-res-quiet";
    process.env.AGENTGLASS_RESUME_SAVE_MS = "600000";
    try {
      put(sid, [prompt(sid, "q0")]);
      scan.__dropTailCache(true);
      scan.__resetResumeWriteCount();
      await sweep();
      expect(scan.__resumeWriteCount()).toBe(1);
      for (let i = 0; i < 10; i++) await sweep();
      expect(scan.__resumeWriteCount()).toBe(1); // 10 idle sweeps: 0 more
      for (let i = 0; i < 10; i++) { add(sid, [prompt(sid, `g${i}`)]); await sweep(); }
      expect(scan.__resumeWriteCount()).toBe(1); // 10 appends inside the window: 0 more
      expect(prompts(sid).length).toBe(11);
    } finally { delete process.env.AGENTGLASS_RESUME_SAVE_MS; }
  });

  test("a lagging row resumes from its offset: state-only re-parse, no duplicate events", async () => {
    const sid = "s-res-lag";
    process.env.AGENTGLASS_RESUME_SAVE_MS = "600000";
    try {
      put(sid, Array.from({ length: 10 }, (_, i) => prompt(sid, `l${i}`)));
      scan.__dropTailCache(true);
      await sweep(); // row saved at 10 lines
      add(sid, [prompt(sid, "l10"), prompt(sid, "l11"), prompt(sid, "l12")]);
      await sweep(); // throttled: row stays at 10, lines_done = 13
      add(sid, [prompt(sid, "l13")]);
      scan.__dropTailCache(true);
      scan.__resetLinesParsedCount();
      await sweep();
      expect(scan.__linesParsedCount()).toBe(4); // 3 for state + 1 new, not 14
      expect(prompts(sid)).toEqual(Array.from({ length: 14 }, (_, i) => `l${i}`));
    } finally { delete process.env.AGENTGLASS_RESUME_SAVE_MS; }
  });

  test("payload of the saved row on the fixture", async () => {
    const sid = "s-res-size";
    const usage = { input_tokens: 10, output_tokens: 5 };
    // 50 replies, each with its own message id and usage, and 3 calls left open.
    const ls: string[] = [];
    for (let i = 0; i < 50; i++) ls.push(toolUse(sid, `c${i}`, usage));
    for (let i = 0; i < 50; i++) if (i >= 3) ls.push(toolResult(sid, `c${i}`));
    put(sid, ls);
    scan.__dropTailCache(true);
    await sweep();
    const row = db.db.query<{ n: number }, [string]>("SELECT length(state) AS n FROM transcript_resume WHERE path = ?").get(path(sid));
    console.log(`resume row payload: ${row?.n} bytes (50 seen ids, 3 open calls)`);
    expect(row?.n).toBeGreaterThan(0);
    expect(row!.n).toBeLessThan(8 * 1024);
  });
});

describe("review fixes: resume keyed to its file, refusal rows", () => {
  const nrefused = () => db.db.query<{ n: number }, []>("SELECT count(*) n FROM transcript_refused").get()!.n;

  test("1. a file rewritten while down, same or larger size, is read whole", async () => {
    const sid = "s-res-swap";
    put(sid, Array.from({ length: 20 }, (_, i) => prompt(sid, `old${i}`)));
    await sweep();
    scan.__dropTailCache(true);
    // Different content, longer than the old file: bytes/lines guards alone pass.
    put(sid, Array.from({ length: 30 }, (_, i) => prompt(sid, `new${i}`)));
    scan.__resetLinesParsedCount();
    await sweep();
    expect(scan.__linesParsedCount()).toBeGreaterThanOrEqual(30); // whole read, not a mid-line tail
  });

  test("1b. same head, different bytes before the offset: read whole; unchanged: resume", async () => {
    const sid = "s-res-mid";
    const pad = "x".repeat(300);
    const head = Array.from({ length: 20 }, (_, i) => prompt(sid, `h${i}${pad}`)); // > 4 KB, identical in both versions
    const body = (tag: string) => Array.from({ length: 10 }, (_, i) => prompt(sid, `${tag}${i}`));
    put(sid, [...head, ...body("old")]);
    await sweep();
    expect(await reboot()).toBe(0); // unchanged file: resume
    scan.__dropTailCache(true);
    await new Promise((r) => setTimeout(r, 20));
    // Same 4 KB head, other bytes just before the old offset, and longer.
    put(sid, [...head, ...body("new"), prompt(sid, "tail1"), prompt(sid, "tail2")]);
    scan.__resetLinesParsedCount();
    await sweep();
    expect(scan.__linesParsedCount()).toBeGreaterThanOrEqual(32); // whole read, not a mid-line tail
    const got = prompts(sid);
    expect(got.filter((x) => x === "tail1").length).toBe(1);
    expect(got.filter((x) => x === "tail2").length).toBe(1);
    expect(got.length).toBe(32); // 30 before the rewrite + 2 new, none twice
  });

  test("2. forgetting a path that has no row writes nothing", () => {
    const p = path("s-res-none");
    const before = scan.__refusedDeleteCount();
    scan.__forgetRefused(p);
    expect(scan.__refusedDeleteCount()).toBe(before); // no row: no DELETE issued
    scan.__noteRefused(p, "sc", 5, 1);
    expect(nrefused()).toBeGreaterThanOrEqual(1);
    scan.__forgetRefused(p);
    expect(db.db.query("SELECT 1 FROM transcript_refused WHERE path = ?").get(p)).toBeNull();
  });

  test("3. a verdict loaded from disk keeps its stored time", () => {
    const p = path("s-res-old");
    scan.__dropTailCache();
    db.db.run("INSERT OR REPLACE INTO transcript_refused (path, scope, size, mtime, at) VALUES (?, 'sc', 5, 1, ?)", [p, Date.now() - 3_600_000]);
    expect(scan.__stillRefused(p, "sc", 5, 1)).toBe("stale"); // not "yes": an hour old
    db.db.run("DELETE FROM transcript_refused WHERE path = ?", [p]);
  });

  test("4. evicting from the refused map deletes its row", () => {
    scan.__dropTailCache();
    scan.__setMaxRefused(2);
    try {
      for (const n of ["a", "b", "c", "d"]) scan.__noteRefused(path("s-res-ev-" + n), "sc", 5, 1);
      expect(nrefused()).toBe(2);
    } finally { scan.__setMaxRefused(4096); scan.__dropTailCache(); }
  });
});
