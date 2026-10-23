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
const now = Date.now();
db.db.run("INSERT INTO seat_line (root, line, at) VALUES ('/w/orbit', 'worker blocked on review', ?)", [now]);
db.db.run("INSERT INTO seat_report (root, agent, state, at) VALUES ('/w/orbit', 'builder-1', 'done', ?)", [now]);
db.db.run("INSERT INTO understudy_snapshots (hash, at, body) VALUES ('h1', ?, 'a situation body')", [now]);
db.db.run("INSERT INTO named_agent (name, cwd, pane_id, window_id, started_at, ended_at) VALUES ('old', '/w/orbit', '%1', '@1', ?, ?)", [now - 10, now - 5]);
db.db.run("INSERT INTO named_agent (name, cwd, pane_id, window_id, started_at) VALUES ('live', '/w/orbit', '%2', '@2', ?)", [now]);
db.db.run("INSERT INTO seat_need (id, root, text, created, done_at) VALUES ('n1', '/w/orbit', 'settled question', ?, ?)", [now - 10, now - 5]);
db.db.run("INSERT INTO seat_need (id, root, text, created) VALUES ('n2', '/w/orbit', 'unanswered question', ?)", [now]);
const agentRows = () => ({ line: n("seat_line"), report: n("seat_report"), snap: n("understudy_snapshots"), named: n("named_agent"), need: n("seat_need") });
const agentBefore = agentRows();
const before = { events: n("events"), sessions: n("sessions"), days: n("daily_rollup") };
const erased = db.eraseHistory();
const after = { events: n("events"), sessions: n("sessions"), days: n("daily_rollup") };
const again = db.eraseHistory();
console.log(JSON.stringify({ before, erased, after, again, agentBefore, agentAfter: agentRows() }));
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

  test("the orchestrator's lines and reports and the understudy's snapshots go too; what is still live or waiting stays", () => {
    expect(out.agentBefore).toEqual({ line: 1, report: 1, snap: 1, named: 2, need: 2 });
    expect(out.agentAfter).toEqual({ line: 0, report: 0, snap: 0, named: 1, need: 1 });
  });

  test("it clears every table the hourly sweep ages out, or names why one stays", async () => {
    const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
    const slice = (name: string) => { const i = src.indexOf(`export function ${name}(`); return src.slice(i, src.indexOf("\n}\n", i)); };
    const tables = (t: string) => new Set([...t.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]!));
    const swept = tables(slice("pruneOldRows"));
    const erased = tables(slice("eraseHistory"));
    // session_role marks which live session is the chair or the Lantern: a mark, not history. The rest of the hourly sweep is event retention.
    const stays = new Set(["session_role"]);
    expect([...swept].filter((t) => !erased.has(t) && !stays.has(t))).toEqual([]);
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
