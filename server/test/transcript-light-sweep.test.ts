// The 3s sweep used to stat every transcript on disk each tick — over a
// thousand stat calls a second on a machine holding a few thousand finished
// sessions. A light sweep now leaves files untouched for ten minutes to the
// full sweep, and these tests pin what that must not cost: a NEW file, and a
// file that is still being written, both turn up on the very next light sweep.
// Only a cold file that comes back to life waits for the full one.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-light-"));
const PROJECTS = join(dir, "projects", "-tmp-lightproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "light.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "lightproj");

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-light-fixture");
  mkdirSync(CWD, { recursive: true });
});

const FIXTURES = ["l-cold", "l-warm", "l-new"];
afterAll(() => {
  if (db) {
    const marks = FIXTURES.map(() => "?").join(",");
    for (const t of ["events", "sessions", "transcript_files"]) {
      try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, FIXTURES); } catch { /* column may not exist */ }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();
const path = (name: string) => join(PROJECTS, `${name}.jsonl`);
const line = (sid: string, text: string) =>
  JSON.stringify({ type: "user", cwd: CWD, sessionId: sid, timestamp: ts(), message: { role: "user", content: text } }) + "\n";
const count = (sid: string) =>
  db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE session_id = ?").get(sid)!.n;
const age = (name: string, minutes: number) => {
  const t = new Date(Date.now() - minutes * 60_000);
  utimesSync(path(name), t, t);
};

describe("light transcript sweep", () => {
  test("a new file and a growing one are picked up without a full sweep", async () => {
    writeFileSync(path("l-warm"), line("l-warm", "one"));
    await scan.scanOnce(null);
    expect(count("l-warm")).toBe(1);

    appendFileSync(path("l-warm"), line("l-warm", "two"));
    writeFileSync(path("l-new"), line("l-new", "fresh"));
    await scan.scanOnce(null, false);
    expect(count("l-warm")).toBe(2);
    expect(count("l-new")).toBe(1);
  });

  test("a cold file that grows waits for the full sweep", async () => {
    writeFileSync(path("l-cold"), line("l-cold", "old"));
    age("l-cold", 60);
    await scan.scanOnce(null);
    expect(count("l-cold")).toBe(1);

    appendFileSync(path("l-cold"), line("l-cold", "resumed"));
    age("l-cold", 60); // still looks cold: it is the file's mtime the sweep trusts
    await scan.scanOnce(null, false);
    expect(count("l-cold")).toBe(1);

    await scan.scanOnce(null);
    expect(count("l-cold")).toBe(2);
  });
});
