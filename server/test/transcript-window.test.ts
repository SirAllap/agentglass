// A cold start has no tail cache, so a transcript used to be read whole: an
// isolated server over a 12 GB projects dir (largest file 1.75 GB) peaked at
// 6.8 GB RSS in under 10 s, and 0.65 GB once it read 64 MB windows instead.
// Windowing is only safe if every line is still ingested once, lines_done is
// exact, and a tool_result still finds the tool_use that sat in an earlier window.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-window-"));
const PROJECTS = join(dir, "projects", "-tmp-windowproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "window.db");
const prior = process.env.AGENTGLASS_SCAN_WINDOW_BYTES;
process.env.AGENTGLASS_SCAN_WINDOW_BYTES = "4096"; // read per sweep; ~6 lines per window below

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "windowproj");
const SID = "w-many";

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-window-fixture");
  mkdirSync(CWD, { recursive: true });
});
afterAll(() => {
  if (prior === undefined) delete process.env.AGENTGLASS_SCAN_WINDOW_BYTES;
  else process.env.AGENTGLASS_SCAN_WINDOW_BYTES = prior;
  if (!db) return;
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id = ?`, [SID]); } catch { /* column may not exist */ }
  }
});

let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();
const line = (o: object) => JSON.stringify({ cwd: CWD, sessionId: SID, timestamp: ts(), ...o });

describe("windowed transcript read", () => {
  test("a file many windows long ingests every line once and keeps tool state across windows", async () => {
    const pad = "x".repeat(600);
    const lines: string[] = [];
    // The call is in the first window, its result in the last.
    lines.push(line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/acme/a.ts" } }] } }));
    for (let i = 0; i < 60; i++) lines.push(line({ type: "user", message: { role: "user", content: `p${i} ${pad}` } }));
    lines.push(line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } }));
    const file = join(PROJECTS, `${SID}.jsonl`);
    const text = lines.map((l) => l + "\n").join("");
    writeFileSync(file, text);
    expect(text.length).toBeGreaterThan(4096 * 10); // spans many windows

    await scan.scanOnce(null);

    const ev = db.db.query<{ hook_event_type: string; tool_name: string | null; payload: string }, [string]>("SELECT hook_event_type, tool_name, payload FROM events WHERE session_id = ? ORDER BY id").all(SID);
    const prompts = ev.filter((r) => r.hook_event_type === "UserPromptSubmit").map((r) => JSON.parse(r.payload).prompt as string);
    expect(prompts.length).toBe(60);
    expect(new Set(prompts).size).toBe(60);
    const post = ev.filter((r) => r.hook_event_type === "PostToolUse");
    expect(post.length).toBe(1);
    expect(post[0]!.tool_name).toBe("Read");
    const done = db.db.query<{ lines_done: number }, [string]>("SELECT lines_done FROM transcript_files WHERE path = ?").get(file);
    expect(done?.lines_done).toBe(lines.length);
  });
});
