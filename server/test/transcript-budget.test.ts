// A cold database used to ingest every transcript in one sweep, in whatever
// order the directories listed. A budgeted sweep stops after N bytes, newest
// file first, and leaves the rest for the next one. What this pins: the newest
// session lands first, nothing is dropped across the chunks, and a file the
// budget passed over is still visible to a light sweep (it is not mistaken for
// a finished one).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-budget-"));
const PROJECTS = join(dir, "projects", "-tmp-budgetproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "budget.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "budgetproj");

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-budget-fixture");
  mkdirSync(CWD, { recursive: true });
});

const FIXTURES = ["b-old", "b-mid", "b-new"];
afterAll(() => {
  if (db) {
    const marks = FIXTURES.map(() => "?").join(",");
    for (const t of ["events", "sessions", "transcript_files"]) {
      try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, FIXTURES); } catch { /* column may not exist */ }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const path = (name: string) => join(PROJECTS, `${name}.jsonl`);
const count = (sid: string) =>
  db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE session_id = ?").get(sid)!.n;
const write = (sid: string, hoursAgo: number) => {
  const at = new Date(Date.now() - hoursAgo * 3_600_000);
  const rows = [1, 2, 3].map((i) =>
    JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: at.toISOString(), message: { role: "user", content: `line ${i}` } }) + "\n");
  writeFileSync(path(sid), rows.join(""));
  utimesSync(path(sid), at, at);
};

const step = story();

describe("budgeted transcript sweep", () => {
  step("newest first, one file per chunk, nothing dropped", async () => {
    write("b-old", 30);
    write("b-new", 1);
    write("b-mid", 10);

    // A budget of one byte is spent by the first file it reads.
    await scan.scanOnce(null, true, 1);
    expect([count("b-new"), count("b-mid"), count("b-old")]).toEqual([3, 0, 0]);
    expect(scan.scanBacklog()).toBe(2);

    // A light sweep still sees the two it passed over: they were never cold.
    await scan.scanOnce(null, false, 1);
    expect([count("b-new"), count("b-mid"), count("b-old")]).toEqual([3, 3, 0]);
    expect(scan.scanBacklog()).toBe(1);

    await scan.scanOnce(null, true, 1);
    expect([count("b-new"), count("b-mid"), count("b-old")]).toEqual([3, 3, 3]);
    expect(scan.scanBacklog()).toBe(0);
  });

  step("no budget reads everything in one sweep", async () => {
    await scan.scanOnce(null);
    expect(scan.scanBacklog()).toBe(0);
    expect(count("b-old")).toBe(3);
  });
});
