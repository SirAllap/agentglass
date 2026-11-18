// GET /export used to build a ~99 MB body in memory. It now streams pages.
// These tests pin two things: the streamed bytes equal the old in-memory
// build, and rows are read in pages rather than all at once.
import { describe, expect, test, beforeAll } from "bun:test";

// No env is set here on purpose: `bun test` runs every file in one process and
// db.ts opens its file once, at the first import, so a file that sets its own
// AGENTGLASS_DB is only right when it happens to load first. This file uses
// whatever DB is open and derives every expectation from what it holds.

let db: typeof import("../src/db.ts");
let ex: typeof import("../src/exportStream.ts");

const ROWS = 7;
const chunks = (n: number, size: number) =>
  Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size));

beforeAll(async () => {
  db = await import("../src/db.ts");
  ex = await import("../src/exportStream.ts");
  for (let i = 0; i < ROWS; i++) {
    db.insertEvent({
      source_app: "orbit",
      session_id: `s-${i % 2}`,
      hook_event_type: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: null,
      agent_id: null,
      agent_type: null,
      model_name: "claude-opus-4-8",
      is_error: i === 3 ? 1 : 0,
      // Commas, quotes and a newline: the CSV escaping has to survive paging.
      error_text: i === 3 ? 'boom, "quoted"\nsecond line' : null,
      usage: { input_tokens: 10 + i, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
      usage_is_cumulative: false,
      summary: `did thing ${i}`,
      timestamp: 1_700_000_000_000 + i,
      payload: { project_path: process.env.AGENTGLASS_ROOT || "/tmp/orbit", note: `n${i}` },
      chat: null,
    } as any);
  }
});

const read = async (s: ReadableStream<Uint8Array>) => await new Response(s).text();

describe("export stream", () => {
  test("json is byte for byte the old in-memory output", async () => {
    const old = JSON.stringify(db.exportRows(), null, 2);
    expect(await read(ex.exportStream(db.exportPages(3), "json"))).toBe(old);
  });

  test("csv is byte for byte the old in-memory output", async () => {
    const rows = db.exportRows();
    const lines = [ex.EVENT_CSV_COLS.join(",")];
    for (const r of rows) lines.push(ex.EVENT_CSV_COLS.map((c) => ex.csvEscape((r as any)[c])).join(","));
    expect(await read(ex.exportStream(db.exportPages(3), "csv"))).toBe(lines.join("\n"));
  });

  test("an empty table still gives the old output", async () => {
    expect(await read(ex.exportStream([], "json"))).toBe(JSON.stringify([], null, 2));
    expect(await read(ex.exportStream([], "csv"))).toBe(ex.EVENT_CSV_COLS.join(","));
  });

  test("rows are read in pages, in id order, up to the cap", () => {
    const total = db.exportRows().length;
    expect(total).toBeGreaterThan(3);
    const pages = [...db.exportPages(3)];
    expect(pages.map((p) => p.length)).toEqual(chunks(total, 3));
    const ids = pages.flat().map((r: any) => r.id);
    expect(ids).toEqual(db.exportRows().map((r: any) => r.id));
    expect([...db.exportPages(3, 4)].map((p) => p.length)).toEqual([3, 1]);
  });

  test("pages are pulled one at a time, not read ahead", async () => {
    let pulled = 0;
    function* src() {
      for (const p of db.exportPages(2)) {
        pulled++;
        yield p;
      }
    }
    const reader = ex.exportStream(src(), "json").getReader();
    await reader.read();
    expect(pulled).toBe(1);
    await reader.cancel();
  });
});
