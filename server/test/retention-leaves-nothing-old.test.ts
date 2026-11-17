/*
 * Retention must leave no event older than the window, in an open session or a closed one.
 * Fixture DB only; a child process so NODE_ENV and the DB path are set before db.ts loads.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agx-retold-"));
const DB_URL = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;

function run(body: string): any {
  const code = `
    process.env.NODE_ENV = "test";
    process.env.AGENTGLASS_DB = ${JSON.stringify(join(dir, "f.db"))};
    process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
    process.env.AGENTGLASS_RETENTION_DAYS = "8";
    const m = await import(${JSON.stringify(DB_URL)}); const { db } = m;
    ${body}`;
  const r = Bun.spawnSync([process.execPath, "--eval", code], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString());
}

test("old events go in an open session and a closed one", async () => {
  run(`
    const D = 86400000, now = Date.now();
    const ins = db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, payload, timestamp) VALUES ('claude-code', ?, 'PostToolUse', 'Edit', ?, ?)");
    const ses = db.prepare("INSERT OR IGNORE INTO sessions (session_id, source_app, started_at, last_seen) VALUES (?, 'claude-code', ?, ?)");
    db.transaction(() => {
      ses.run("open", now - 12 * D, now); ses.run("closed", now - 12 * D, now - 11 * D);
      const pad = JSON.stringify({ pad: "x".repeat(2000) });
      for (let i = 0; i < 6000; i++) {
        ins.run("open", pad, now - 10 * D - i);
        ins.run("open", pad, now - i);
        ins.run("closed", pad, now - 11 * D - i);
      }
    })();
    process.stdout.write("{}");`);
  const before = statSync(join(dir, "f.db")).size;
  const out = run(`
    const cnt = () => db.query("SELECT COUNT(*) n FROM events WHERE timestamp < ?").get(Date.now() - 8 * 86400000).n;
    const old0 = cnt();
    const free = () => Number(db.query("PRAGMA freelist_count").get().freelist_count);
    const mode = Number(db.query("PRAGMA auto_vacuum").get().auto_vacuum);
    const f0 = free();
    await m.pruneOldRowsYielding();
    process.stdout.write(JSON.stringify({ old0, old1: cnt(), left: db.query("SELECT COUNT(*) n FROM events").get().n, mode, f0, f1: free() }));`);
  const after = statSync(join(dir, "f.db")).size;
  console.log("measure", JSON.stringify({ ...out, bytesBefore: before, bytesAfter: after }));
  expect(out.old0).toBe(12000);
  expect(out.old1).toBe(0);
  expect(out.left).toBe(6000);
});

test("a fresh file is auto_vacuum INCREMENTAL, so the freed pages go back", async () => {
  const out = run(`process.stdout.write(JSON.stringify({ mode: Number(db.query("PRAGMA auto_vacuum").get().auto_vacuum) }));`);
  expect(out.mode).toBe(2);
});
