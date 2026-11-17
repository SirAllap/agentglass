/*
 * GET /prs/spend must not freeze the server while it reads.
 *
 * The board's whole spend answer is one synchronously executed SQLite query.
 * On a cold cockpit that was four calls of up to 3,993 ms in one session's log,
 * measured by the loop watchdog as "computing": the query runs on the thread
 * the terminal and every other route ride, so nothing answers until it is done.
 *
 * Measured the way the git panel is: a /health request fired while the spend
 * read is in flight, with the ping and the read started together and the ping
 * expected back first.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-spend-loop-"));
const DB = join(dir, "spend.db");
const ROOT = join(dir, "code", "acme");
/** Enough costed turns that the one query is a real block on a warm database. */
const EVENTS = 300_000;

let base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  base = `http://127.0.0.1:${await freePort()}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: ROOT,
      AGENTGLASS_DB: DB,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: new URL(base).port,
    },
    stdout: "ignore", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) throw new Error("server did not start");

  // Seven days of turns, a tenth of them costed, the way a real week of one
  // project looks to this query. Written straight into the table: through the
  // hook it would be 150,000 round trips.
  const db = new Database(DB);
  const ins = db.prepare(
    "INSERT INTO events (source_app, session_id, hook_event_type, cost_usd, payload, timestamp) VALUES (?,?,?,?,?,?)"
  );
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < EVENTS; i++) {
      ins.run("acme", `s-${i % 500}`, "Stop", i % 10 === 0 ? 0.01 : 0,
        JSON.stringify({ project_path: ROOT, cwd: ROOT, git_branch: `feat/orbit-${i % 25}` }),
        now - (i % 604_800) * 1000);
    }
  })();
  db.close();
}, 120_000);

afterAll(() => {
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

test("a health ping lands while the spend read is still going", async () => {
  const t0 = performance.now();
  const spend = fetch(`${base}/prs/spend?root=${encodeURIComponent(ROOT)}`).then(async (r) => {
    const took = performance.now() - t0;
    return { took, body: (await r.json()) as { ok: boolean; branches?: { branch: string; usd: number }[] } };
  });

  let healthMs = 0;
  const until = performance.now() + 2_000;
  while (performance.now() < until) {
    const s = performance.now();
    const h = await fetch(base + "/health");
    const took = performance.now() - s;
    expect(h.ok).toBe(true);
    if (took > healthMs) healthMs = took;
    await Bun.sleep(5);
  }
  const answer = await spend;
  console.log(`[measure] /prs/spend ${Math.round(answer.took)} ms, worst /health during it ${Math.round(healthMs)} ms`);
  expect(answer.body.ok).toBe(true);
  // The answer is unchanged by how it was assembled: every fiftieth seeded turn
  // is branch 0's and costed, at a cent each.
  const orbit = (answer.body.branches ?? []).find((b) => b.branch === "feat/orbit-0");
  expect(orbit?.usd ?? 0).toBeCloseTo(60, 4);
  // Either the ping came back inside the read (after: the read is sliced and
  // yields), or the read finished before the first ping got a chance to wait.
  // Before: the loop is held for the whole query, so the ping's own latency is
  // the rest of the read.
  expect(healthMs, "a health ping was held").toBeLessThan(150);
  expect(healthMs, "the ping waited out most of the spend read").toBeLessThan(answer.took / 2);
}, 120_000);
