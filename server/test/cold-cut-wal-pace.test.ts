/*
 * The cold event cut must not outrun the checkpoint.
 *
 * On a 1.6 GB database the first cut rewrote ~1.1 M rows and the WAL reached
 * ~28 MB; the catch-up checkpoint then copied it all in one call, 0.5-7.5 s on
 * the loop. The cut now waits for the log to catch up whenever more than
 * CATCHUP_FRAMES are unwritten back, so one step copies about 8 MB at most.
 * Held here on a fixture of invented rows: the longest checkpoint step and the
 * WAL's high-water mark during a full cut.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "agx-coldwal-"));
const DB_URL = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
const ROWS = 60_000;
const OLD = Date.now() - 400 * 86_400_000;

const run = (dbPath: string, body: string): string => {
  const r = Bun.spawnSync([process.execPath, "--eval", `
    process.env.NODE_ENV = "production";
    process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
    process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
    const m = await import(${JSON.stringify(DB_URL)});
    const { db } = m;
    ${body}`], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
};

test("a full cold cut keeps every checkpoint step short and the WAL under its ceiling", () => {
  const p = join(dir, "cold.db");
  // Fat, old Bash commands with a usage block of invented content (~3 KB each) so the cut has real rewriting to do.
  run(p, `
    const ins = db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, payload, timestamp) VALUES ('claude-code', ?, 'PostToolUse', 'Bash', ?, ?)");
    const fat = JSON.stringify({ tool_name: "Bash", usage: { input_tokens: 9 }, tool_input: { command: "echo orbit && ".repeat(250) } });
    db.transaction(() => { for (let i = 0; i < ${ROWS}; i++) ins.run("s" + (i % 50), fat, ${OLD} + i); })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");`);
  const out = JSON.parse(run(p, `
    m.startCheckpointer();
    const t = m.walStepStats; t.longestMs = 0; t.maxLog = 0; t.bigSteps = 0;
    const slices = await m.slimColdEventsYielding();
    process.stdout.write(JSON.stringify({ slices, ...m.walStepStats, cap: m.WAL_PACE_FRAMES }));`));
  console.log(`[measure] cold cut over ${ROWS} rows: ${out.slices} slices, ${out.steps} checkpoint steps, longest ${Math.round(out.longestMs)} ms, WAL high-water ${out.maxLog} frames (${Math.round(out.maxLog * 4 / 1024)} MB)`);
  expect(out.slices).toBeGreaterThan(5);
  // Count steps that copied a lot of frames instead of timing them: timing flakes on shared CI.
  expect(out.bigSteps, "a checkpoint step copied a big backlog in one call").toBe(0);
  // Pace threshold plus one slice of slack; the unpaced cut reached ~7000 frames (28 MB).
  expect(out.maxLog, "the WAL outgrew its ceiling").toBeLessThan(out.cap * 3);
}, 120_000);

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });
