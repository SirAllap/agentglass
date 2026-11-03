// "Open 1" sat on a spinner for 40 s on a fresh server: the picker awaited
// resyncScope(), which first waits for the whole-machine startup backfill to
// let go of the sweep flag. The same POST straight after answered in 32 ms.
// What this pins: the picker is answered while a sweep is still reading.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-resync-bounded-"));
const PROJECTS = join(dir, "projects", "-tmp-resyncbounded");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "bounded.db");
process.env.AGENTGLASS_SCAN_RESYNC_BUDGET_BYTES = String(1024 * 1024);
process.env.AGENTGLASS_SCAN_COLD_BUDGET_BYTES = String(1024 * 1024);
process.env.AGENTGLASS_SCAN_COLD_PAUSE_MS = "0";

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
});

afterAll(() => {
  // The database lives in this directory only if this file was the first to import db.ts, and
  // then it is every later file's database too: one process, one connection, one path. Removing
  // it here pulls the directory from under a test that hands DB.dbPath() to a child, which then
  // cannot open it. The preload's sweep removes it when the process ends.
  if (!db || !db.dbPath().startsWith(dir + "/")) rmSync(dir, { recursive: true, force: true });
});

const write = (sid: string, hoursAgo: number) => {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  const pad = "x".repeat(700);
  const rows = Array.from({ length: 500 }, (_, i) =>
    JSON.stringify({ type: "user", cwd: PROJECTS, sessionId: sid, timestamp: at.toISOString(), message: { role: "user", content: `line ${i} ${pad}` } }) + "\n");
  writeFileSync(join(PROJECTS, `${sid}.jsonl`), rows.join(""));
};

describe("resyncScopeBounded", () => {
  test("answers while a sweep still holds the flag", async () => {
    for (let i = 0; i < 40; i++) write(`b-${i}`, 60 + i);
    const first = scan.resyncScope(); // takes the flag and hands a backlog on
    const t0 = Date.now();
    const finished = await scan.resyncScopeBounded(100);
    const ms = Date.now() - t0;
    await first;
    expect(finished).toBe(false);
    expect(ms).toBeLessThan(1_500);
  });
});
