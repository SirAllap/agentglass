// One turn end is one Stop row. Claude Code writes one jsonl line per content block of a reply,
// so a reply that narrates and then calls a tool is a text-only line followed by a tool_use line
// with the same message.id. The text line used to be read as a turn end: one Stop per narrated
// tool call (one real session: 42,369 Stop rows in 3 days on a few hundred turns).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-stop-"));
const PROJECTS = join(dir, "projects", "-tmp-stopproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "stop.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "stopproj");
const SID = "s-stop-per-turn";

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-stop-fixture");
  mkdirSync(CWD, { recursive: true });
});
afterAll(() => {
  if (!db) return;
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id = ?`, [SID]); } catch { /* no such column */ }
  }
});

let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();
const line = (type: string, message: unknown) => JSON.stringify({ type, cwd: CWD, sessionId: SID, timestamp: ts(), message });
const asst = (id: string, content: unknown[]) => line("assistant", { id, model: "claude-opus-4-8", role: "assistant", content });

describe("Stop per turn", () => {
  test("narration before a tool call is not a turn end; the final text is", async () => {
    const lines = [
      line("user", { role: "user", content: "go" }),
      // three narrated tool calls: text line + tool_use line per reply (same message.id)
      ...["a", "b", "c"].flatMap((k) => [
        asst(`m-${k}`, [{ type: "text", text: `looking at ${k}` }]),
        asst(`m-${k}`, [{ type: "tool_use", id: `t-${k}`, name: "Bash", input: { command: "ls" } }]),
        line("user", { role: "user", content: [{ type: "tool_result", tool_use_id: `t-${k}`, content: "ok" }] }),
      ]),
      asst("m-final", [{ type: "text", text: "done" }]),
    ];
    writeFileSync(join(PROJECTS, `${SID}.jsonl`), lines.map((l) => l + "\n").join(""));
    await scan.scanOnce(null);
    const r = db.db.query<{ hook_event_type: string }, [string]>(
      "SELECT hook_event_type FROM events WHERE session_id = ? ORDER BY id").all(SID).map((x) => x.hook_event_type);
    expect(r.filter((t) => t === "Stop").length).toBe(1);
    expect(r.filter((t) => t === "PreToolUse").length).toBe(3);
    expect(r.filter((t) => t === "PostToolUse").length).toBe(3);
    expect(r.filter((t) => t === "UserPromptSubmit").length).toBe(1);
  });

  test("thinking + text + tool_use (one id, three lines) writes no Stop, and usage totals stay exact", async () => {
    const SID2 = "s-stop-thinking";
    const usageOf = (n: number) => ({ input_tokens: 1000 + n, output_tokens: 100 + n, cache_creation_input_tokens: 10 * n, cache_read_input_tokens: 500 + n });
    const mk = (id: string, content: unknown[], n: number) =>
      JSON.stringify({ type: "assistant", cwd: CWD, sessionId: SID2, timestamp: ts(), message: { id, model: "claude-opus-4-8", role: "assistant", content, usage: usageOf(n) } });
    const lines = [
      JSON.stringify({ type: "user", cwd: CWD, sessionId: SID2, timestamp: ts(), message: { role: "user", content: "go" } }),
      ...[1, 2, 3].flatMap((n) => [
        mk(`th-${n}`, [{ type: "thinking", thinking: "hmm" }], n),
        mk(`th-${n}`, [{ type: "text", text: `narrating ${n}` }], n),
        mk(`th-${n}`, [{ type: "tool_use", id: `tt-${n}`, name: "Bash", input: { command: "ls" } }], n),
        JSON.stringify({ type: "user", cwd: CWD, sessionId: SID2, timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tt-${n}`, content: "ok" }] } }),
      ]),
      mk("th-final", [{ type: "text", text: "done" }], 4),
    ];
    writeFileSync(join(PROJECTS, `${SID2}.jsonl`), lines.map((l) => l + "\n").join(""));
    await scan.scanOnce(null);
    try {
      const types = db.db.query<{ hook_event_type: string }, [string]>(
        "SELECT hook_event_type FROM events WHERE session_id = ? ORDER BY id").all(SID2).map((x) => x.hook_event_type);
      expect(types.filter((t) => t === "Stop").length).toBe(1);
      expect(types.filter((t) => t === "PreToolUse").length).toBe(3);
      // Old code put each reply's usage once (on its first line) = the sum of the four replies' usage.
      const want = [1, 2, 3, 4].map(usageOf);
      const sum = (k: string) => want.reduce((a, u) => a + ((u as Record<string, number>)[k] ?? 0), 0);
      const row = db.db.query<{ i: number; o: number; cc: number; cr: number; c: number }, [string]>(
        "SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_creation_tokens) cc, SUM(cache_read_tokens) cr, SUM(cost_usd) c FROM events WHERE session_id = ?").get(SID2)!;
      expect(row.i).toBe(sum("input_tokens"));
      expect(row.o).toBe(sum("output_tokens"));
      expect(row.cc).toBe(sum("cache_creation_input_tokens"));
      expect(row.cr).toBe(sum("cache_read_input_tokens"));
      expect(row.c).toBeGreaterThan(0);
      const ses = db.db.query<{ i: number; o: number }, [string]>("SELECT input_tokens i, output_tokens o FROM sessions WHERE session_id = ?").get(SID2);
      if (ses) { expect(ses.i).toBe(sum("input_tokens")); expect(ses.o).toBe(sum("output_tokens")); }
    } finally {
      for (const t of ["events", "sessions", "transcript_files"]) {
        try { db.db.run(`DELETE FROM ${t} WHERE session_id = ?`, [SID2]); } catch { /* no such column */ }
      }
    }
  });
});
