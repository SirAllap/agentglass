// Boot backfills sessions.project_path / cwd_path from their events. Measured on
// a copy of a real DB, the `IN (SELECT … FROM events)` guard scanned every event
// on every boot (~1.2 s of a 1.9 s boot); the EXISTS form probes idx_events_session.
// Same rows, so: the backfill still fills, and the plan never scans events.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function boot(dir: string, dbPath: string, body: string): string {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
  const script = `
    process.env.NODE_ENV = "production";
    process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
    process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
    const { db, sessionBackfillSql, backfillSessionPaths } = await import(${JSON.stringify(moduleUrl)});
    ${body}
    db.close();
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  return child.stdout.toString();
}

test("boot backfill fills a session's paths from its events and does not scan events", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-boot-backfill-"));
  const dbPath = join(dir, "a.db");
  boot(dir, dbPath, `
    db.run("INSERT INTO sessions (session_id, source_app, started_at, last_seen) VALUES ('s1','claude-code',1,1)");
    db.run("INSERT INTO sessions (session_id, source_app, started_at, last_seen) VALUES ('s2','claude-code',1,1)");
    db.run("INSERT INTO events (source_app, session_id, hook_event_type, payload, timestamp) VALUES ('claude-code','s1','Stop', ?, 1)",
      [JSON.stringify({ project_path: "/code/orbit", cwd: "/code/orbit-wt" })]);
    db.run("UPDATE sessions SET project_path = NULL, cwd_path = NULL");
  `);
  const out = JSON.parse(boot(dir, dbPath, `
    await backfillSessionPaths(1);
    const rows = db.query("SELECT session_id, project_path, cwd_path FROM sessions ORDER BY session_id").all();
    const plan = ["project_path", "cwd_path"].flatMap((c) => db.query("EXPLAIN QUERY PLAN " + sessionBackfillSql(c)).all().map((r) => r.detail));
    process.stdout.write(JSON.stringify({ rows, plan }));
  `));
  expect(out.rows).toEqual([
    { session_id: "s1", project_path: "/code/orbit", cwd_path: "/code/orbit-wt" },
    { session_id: "s2", project_path: null, cwd_path: null },
  ]);
  expect(out.plan.length).toBeGreaterThan(0);
  expect(out.plan.some((d: string) => /SCAN e\b|SCAN events/.test(d))).toBe(false);
});
