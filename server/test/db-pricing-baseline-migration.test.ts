// The pricing baseline was added after sessions already existed in the wild.
// Start a fresh Bun process on the old schema so this test exercises module-load
// migration exactly as an upgraded installation does.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("backfills an existing session's pricing baseline during migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-pricing-migration-"));
  const dbPath = join(dir, "legacy.db");
  const legacy = new Database(dbPath, { create: true });
  legacy.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      source_app TEXT NOT NULL,
      model_name TEXT,
      provider TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_seen INTEGER NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      tool_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    INSERT INTO sessions (
      session_id, source_app, started_at, last_seen, cost_usd
    ) VALUES ('legacy-session', 'claude-code', 1, 1, 1.2345);
  `);
  legacy.close();

  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
  const script = `
    process.env.NODE_ENV = "production";
    process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
    process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
    const { db } = await import(${JSON.stringify(moduleUrl)});
    const row = db.query("SELECT cost_usd, pricing_baseline_usd FROM sessions WHERE session_id = 'legacy-session'").get();
    process.stdout.write(JSON.stringify(row));
    db.close();
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({
    cost_usd: 1.2345,
    pricing_baseline_usd: 1.2345,
  });
});
