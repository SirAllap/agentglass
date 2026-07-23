// The sweep now ingests a file in bounded batches, each its own transaction,
// yielding the loop between them so a 700MB cold backfill never freezes the PTY.
// Batching is only safe if it still ingests every line exactly once, advances
// lines_done past exactly what committed, keeps the usage-dedupe set alive across
// batch boundaries, and — the deliberate part — steps over a single abnormally
// large line without dropping its neighbours. Each test below is one of those.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-batch-"));
const PROJECTS = join(dir, "projects", "-tmp-batchproj");
mkdirSync(PROJECTS, { recursive: true });
// Sweep this fixture, never ~/.claude/projects. Set before importing.
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "batch.db");

// Tiny batches so a modest fixture spans several of them — the knobs are read
// per sweep (not pinned at import), so setting them here takes effect and the
// afterAll restore keeps other test files on the defaults.
const priorBatchLines = process.env.AGENTGLASS_SCAN_BATCH_LINES;
const priorBatchBytes = process.env.AGENTGLASS_SCAN_BATCH_BYTES;
process.env.AGENTGLASS_SCAN_BATCH_LINES = "3";
process.env.AGENTGLASS_SCAN_BATCH_BYTES = String(64 * 1024);

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "batchproj");

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-batch-fixture");
  mkdirSync(CWD, { recursive: true });
});

const FIXTURES = ["b-many", "b-usage", "b-oversize", "b-drift"];
afterAll(() => {
  process.env.AGENTGLASS_SCAN_BATCH_LINES = priorBatchLines;
  process.env.AGENTGLASS_SCAN_BATCH_BYTES = priorBatchBytes;
  if (!db) return;
  const marks = FIXTURES.map(() => "?").join(",");
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, FIXTURES); } catch { /* column may not exist */ }
  }
});

const sweep = () => scan.scanOnce(null);
let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();
const path = (name: string) => join(PROJECTS, `${name}.jsonl`);
const write = (name: string, lines: string[]) => writeFileSync(path(name), lines.map((l) => l + "\n").join(""));
const append = (name: string, lines: string[]) => appendFileSync(path(name), lines.map((l) => l + "\n").join(""));

const prompt = (sid: string, text: string) =>
  JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: ts(), message: { role: "user", content: text } });

const rows = (sid: string) =>
  db.db
    .query<{ hook_event_type: string; payload: string }, [string]>(
      "SELECT hook_event_type, payload FROM events WHERE session_id = ? ORDER BY id"
    )
    .all(sid);
const prompts = (sid: string) =>
  rows(sid).filter((r) => r.hook_event_type === "UserPromptSubmit").map((r) => JSON.parse(r.payload).prompt as string);
const progress = (name: string) =>
  db.db.query<{ lines_done: number }, [string]>("SELECT lines_done FROM transcript_files WHERE path = ?").get(path(name));

describe("batched transcript sweep", () => {
  test("a file spanning many batches ingests every line exactly once", async () => {
    const sid = "b-many";
    // 10 lines at 3/batch = four batches (3+3+3+1), the last one straddling none.
    write("many", Array.from({ length: 10 }, (_, i) => prompt(sid, `m${i}`)));
    await sweep();
    expect(prompts(sid)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    expect(progress("many")?.lines_done).toBe(10);

    // An append that itself spans batches, read via the warm tail: no line
    // re-ingested at the boundary, none dropped.
    append("many", Array.from({ length: 5 }, (_, i) => prompt(sid, `a${i}`)));
    await sweep();
    expect(prompts(sid)).toEqual([...Array.from({ length: 10 }, (_, i) => `m${i}`), ...Array.from({ length: 5 }, (_, i) => `a${i}`)]);
    expect(progress("many")?.lines_done).toBe(15);

    // Cold cache (a restart), warm DB: the from-zero re-read walks the already
    // ingested prefix in batches without walking lines_done backwards, then
    // ingests only the genuinely new lines.
    scan.__dropTailCache();
    append("many", Array.from({ length: 4 }, (_, i) => prompt(sid, `c${i}`)));
    await sweep();
    expect(prompts(sid)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `m${i}`),
      ...Array.from({ length: 5 }, (_, i) => `a${i}`),
      ...Array.from({ length: 4 }, (_, i) => `c${i}`),
    ]);
    expect(progress("many")?.lines_done).toBe(19);

    // Unchanged file: no manufacturing on a re-run.
    await sweep();
    expect(prompts(sid).length).toBe(19);
  });

  test("a newline-less record doesn't drift lines_done and drop the next one", async () => {
    const sid = "b-drift";
    // A, then B: a complete record whose terminating newline hasn't landed yet
    // — a live write caught between the record's bytes and its "\n". Raw writes,
    // because the helpers always append a newline.
    writeFileSync(path("drift"), prompt(sid, "A") + "\n" + prompt(sid, "B"));
    await sweep();
    expect(prompts(sid)).toEqual(["A", "B"]); // B is taken now, not held forever

    // B's newline lands. This must NOT be counted as a new (empty) line: the
    // record was already ingested, and drifting lines_done past the true count
    // is what makes a later cold re-read over-skip.
    appendFileSync(path("drift"), "\n");
    await sweep();
    expect(prompts(sid)).toEqual(["A", "B"]); // no duplicate
    expect(progress("drift")?.lines_done).toBe(2); // two records, not three

    // A restart drops the byte offsets but keeps lines_done. A new record C then
    // arrives; with a drifted lines_done the from-zero re-read would skip it.
    scan.__dropTailCache();
    appendFileSync(path("drift"), prompt(sid, "C") + "\n");
    await sweep();
    expect(prompts(sid)).toEqual(["A", "B", "C"]); // C must survive
  });

  test("one reply's usage survives the batch boundary and is not double counted", async () => {
    // Two content-block lines of the same message.id, each in its own batch
    // (batch size 3, one tool_use line then these). seenUsage must carry across
    // the batch commit or the second line re-adds the whole reply's tokens.
    const sid = "b-usage";
    const usage = { input_tokens: 100, output_tokens: 10 };
    const asst = (id: string) =>
      JSON.stringify({
        type: "assistant", cwd: CWD, sessionId: sid, timestamp: ts(),
        message: { id: "msg-1", model: "claude-opus-4-8", role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }], usage },
      });
    // Six lines → the two usage-bearing lines land in different batches.
    write("usage", [asst("u1"), asst("u2"), asst("u3"), asst("u4"), asst("u5"), asst("u6")]);
    await sweep();
    const s = db.db
      .query<{ input_tokens: number; output_tokens: number }, [string]>("SELECT input_tokens, output_tokens FROM sessions WHERE session_id = ?")
      .get(sid);
    expect(s?.input_tokens).toBe(100);
    expect(s?.output_tokens).toBe(10);
  });

  test("an abnormally large line is skipped, its neighbours are ingested", async () => {
    // The oversize cap is a per-line safety valve for a base64 blob no batching
    // can subdivide. Skipping it must not disturb the records around it. Read the
    // cap per sweep, so setting it here (to the 64KB floor) takes effect; restore
    // after so the rest of the suite keeps the 16MB default.
    const sid = "b-oversize";
    const prior = process.env.AGENTGLASS_SCAN_MAX_LINE_BYTES;
    process.env.AGENTGLASS_SCAN_MAX_LINE_BYTES = String(64 * 1024);
    try {
      const giant = prompt(sid, "X".repeat(100 * 1024)); // >64KB line
      write("oversize", [prompt(sid, "before"), giant, prompt(sid, "after")]);
      await sweep();
      // The giant is stepped over; the two ordinary prompts around it are kept.
      expect(prompts(sid)).toEqual(["before", "after"]);
      // All three lines counted as processed, so the offset stays exact and the
      // next sweep does not re-read the giant.
      expect(progress("oversize")?.lines_done).toBe(3);
    } finally {
      process.env.AGENTGLASS_SCAN_MAX_LINE_BYTES = prior;
    }
  });
});
