/*
 * The red button on Data & privacy.
 *
 * It forgets the history, all of it, and nothing else: the roll-up goes with
 * the events (a summary of rows that no longer exist is the history that was
 * asked to be forgotten). Run in a child process on a scratch database: the
 * erase empties whatever database the process opened, and `bun test` shares one
 * process across every file, so doing it here would empty the next file's rows.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-erase-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });

const PROBE = `
const db = await import("./src/db.ts");
const DAY = 86_400_000;
const ev = (o = {}) => ({ source_app: "proj", session_id: "s1", hook_event_type: "PostToolUse", tool_name: "Bash", tool_use_id: null, agent_id: null, agent_type: null,
  model_name: "claude-opus-4-8", is_error: 0, error_text: null, usage: { input_tokens: 100, output_tokens: 40, cache_creation_tokens: 0, cache_read_tokens: 10 },
  usage_is_cumulative: false, summary: "x", timestamp: Date.now(), payload: { project_path: process.env.AGENTGLASS_ROOT }, chat: null, ...o });
const n = (t) => db.db.query("SELECT COUNT(*) AS n FROM " + t).get().n;
for (let i = 0; i < 3; i++) db.insertEvent(ev({ timestamp: Date.now() - 30 * DAY + i }));
for (let i = 0; i < 2; i++) db.insertEvent(ev({ session_id: "s2", timestamp: Date.now() - i }));
db.pruneOldRows();
const before = { events: n("events"), sessions: n("sessions"), days: n("daily_rollup") };
const erased = db.eraseHistory();
const after = { events: n("events"), sessions: n("sessions"), days: n("daily_rollup") };
const again = db.eraseHistory();
console.log(JSON.stringify({ before, erased, after, again }));
`;

describe("eraseHistory", () => {
  const r = Bun.spawnSync({
    cmd: ["bun", "-e", PROBE], cwd: join(import.meta.dir, ".."),
    env: { ...process.env, AGENTGLASS_DB: join(dir, "erase.db"), AGENTGLASS_ROOT: ROOT, XDG_CONFIG_HOME: dir, AGENTGLASS_STATE_DIR: join(dir, "state"), NODE_ENV: "test" },
  });
  const out = JSON.parse(r.stdout.toString() || "{}") as Record<string, Record<string, number>>;

  test("starts with something to forget: events, sessions and a roll-up day", () => {
    expect(out.before?.events).toBe(2);
    expect(out.before?.sessions).toBeGreaterThan(0);
    expect(out.before?.days).toBeGreaterThan(0);
  });

  test("forgets all of it, roll-up included, and says how much", () => {
    expect(out.erased?.events).toBe(2);
    expect(out.erased?.days).toBeGreaterThan(0);
    expect(out.after).toEqual({ events: 0, sessions: 0, days: 0 });
  });

  test("a second erase finds nothing and is not an error", () => {
    expect(out.again).toEqual({ events: 0, sessions: 0, days: 0 });
  });

  test("the route is the person's alone and asks to be told so", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = src.indexOf('pathname === "/privacy/erase-history"');
    const body = src.slice(at, src.indexOf("\n    }\n", at));
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("mayPublishReview");
    expect(body).toContain('b.confirm !== "erase"');
    expect(body).not.toContain("viaDoor");
  });
});
