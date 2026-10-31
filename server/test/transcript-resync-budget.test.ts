// Widening the workspace used to answer only after EVERY newly eligible
// transcript had been read: the picker sat on "Opening 2 projects…" for
// minutes on a machine with months of sessions. resyncScope() now reads the
// newest few megabytes before answering and finishes the rest in the
// background. What this pins: the answer comes back with the backlog still
// pending, the newest session is already in, and the rest lands afterwards.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-resync-"));
const PROJECTS = join(dir, "projects", "-tmp-resyncproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "resync.db");
process.env.AGENTGLASS_SCAN_RESYNC_BUDGET_BYTES = String(1024 * 1024);
process.env.AGENTGLASS_SCAN_COLD_PAUSE_MS = "0";

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "resyncproj");
const IDS = ["r-1", "r-2", "r-3", "r-4"]; // r-4 is the newest

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-resync-fixture");
  mkdirSync(CWD, { recursive: true });
});

afterAll(() => {
  if (db) {
    const marks = IDS.map(() => "?").join(",");
    for (const t of ["events", "sessions", "transcript_files"]) {
      try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, IDS); } catch { /* column may not exist */ }
    }
  }
  if (!db || !db.dbPath().startsWith(dir + "/")) rmSync(dir, { recursive: true, force: true });
});

const count = (sid: string) =>
  db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE session_id = ?").get(sid)!.n;
/** ~700 KB of lines, so two files spend the 1 MB budget. */
const write = (sid: string, hoursAgo: number) => {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  const pad = "x".repeat(700);
  const rows = Array.from({ length: 1000 }, (_, i) =>
    JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: at.toISOString(), message: { role: "user", content: `line ${i} ${pad}` } }) + "\n");
  const p = join(PROJECTS, `${sid}.jsonl`);
  writeFileSync(p, rows.join(""));
  utimesSync(p, at, at);
};

describe("resyncScope", () => {
  test("answers after the newest chunk, backfills the rest afterwards", async () => {
    IDS.forEach((id, i) => write(id, 40 - i * 10));
    await scan.resyncScope();
    expect(count("r-4")).toBe(1000);
    expect(count("r-1")).toBe(0);
    expect(scan.scanBacklog()).toBeGreaterThan(0);

    const until = Date.now() + 10_000;
    while (count("r-1") < 1000 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(IDS.map(count)).toEqual([1000, 1000, 1000, 1000]);
  });
});
