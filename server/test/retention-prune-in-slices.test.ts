/*
 * The boot retention delete and the session-path backfill must not hold the loop.
 *
 * Measured on an isolated server with 200k old events: the first retention delete
 * took 3.6 s and the first backfill of NULL project_path/cwd_path sessions 1.27 s,
 * both on the event loop. They now run in slices (pruneOldRowsYielding,
 * backfillSessionPaths). Two things are held here: the slices write exactly what
 * one pass writes, and a /health ping is answered while the boot prune deletes.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-retchunk-"));
const DB_URL = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
const EVENTS = 200_000;
const OLD = Date.now() - 400 * 86_400_000;

/** Old events over many days and sessions, a few new ones, sessions with no paths yet. */
const seed = (dbPath: string, n: number) => `
  process.env.NODE_ENV = "production";
  process.env.AGENTGLASS_DB = ${JSON.stringify(dbPath)};
  process.env.AGENTGLASS_ROOT = ${JSON.stringify(dir)};
  process.env.XDG_CONFIG_HOME = ${JSON.stringify(dir)};
  process.env.AGENTGLASS_RETENTION_DAYS = "7";
  const { db } = await import(${JSON.stringify(DB_URL)});
  const ins = db.prepare("INSERT INTO events (source_app, session_id, hook_event_type, tool_name, is_error, input_tokens, cost_usd, duration_ms, payload, timestamp) VALUES ('claude-code', ?, ?, 'Edit', ?, 3, 0.5, 7, ?, ?)");
  const ses = db.prepare("INSERT OR IGNORE INTO sessions (session_id, source_app, started_at, last_seen) VALUES (?, 'claude-code', ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < ${n}; i++) {
      const sid = "s" + (i % 500);
      const t = i < ${n} - 50 ? ${OLD} + (i % 30) * 86400000 : Date.now();
      ses.run(sid, t, t);
      ins.run(sid, i % 2 ? "PostToolUse" : "Stop", i % 5 === 0 ? 1 : 0, JSON.stringify({ project_path: "/code/orbit/p" + (i % 3), cwd: "/code/orbit-wt" }), t);
    }
  })();
  db.run("UPDATE sessions SET project_path = NULL, cwd_path = NULL");
`;

function child(dbPath: string, body: string): string {
  const r = Bun.spawnSync([process.execPath, "--eval", `${seed(dbPath, 0).split("const { db }")[0]}const { db, pruneOldRows, pruneOldRowsYielding, backfillSessionPaths, startCheckpointer } = await import(${JSON.stringify(DB_URL)}); ${body}`],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
}

test("a sliced prune wipes the caches once, after the last slice", async () => {
  const p = join(dir, "epoch.db");
  Bun.spawnSync([process.execPath, "--eval", seed(p, 3000)], { cwd: join(import.meta.dir, ".."), stderr: "inherit" });
  const out = child(p, `const { sessionEventStamp } = await import(${JSON.stringify(DB_URL)});
    const a = Number(sessionEventStamp("s1").split(".")[0]);
    await pruneOldRowsYielding(250);
    process.stdout.write(String(Number(sessionEventStamp("s1").split(".")[0]) - a));`);
  expect(out).toBe("1");
});

test("slices write what one pass writes", async () => {
  const dump = `
    const rows = (q) => db.query(q).all();
    process.stdout.write(JSON.stringify({
      ev: rows("SELECT COUNT(*) n FROM events"), se: rows("SELECT session_id, project_path, cwd_path FROM sessions ORDER BY 1"),
      ro: rows("SELECT * FROM daily_rollup ORDER BY day, project_path, session_id, model_name, provider"),
    }));`;
  const out: string[] = [];
  for (const mode of ["one", "slices"]) {
    const p = join(dir, `eq-${mode}.db`);
    Bun.spawnSync([process.execPath, "--eval", seed(p, 6000)], { cwd: join(import.meta.dir, ".."), stderr: "inherit" });
    const run = mode === "one"
      ? `pruneOldRows(); const sql = (await import(${JSON.stringify(DB_URL)})).sessionBackfillSql; for (const c of ["project_path","cwd_path"]) db.exec(sql(c));`
      : `await pruneOldRowsYielding(250); await backfillSessionPaths(7);`;
    out.push(child(p, `${run} ${dump}`));
  }
  const [one, slices] = out.map((s) => JSON.parse(s));
  expect(slices.ev[0].n).toBe(50);
  expect(slices.ro.length).toBeGreaterThan(0);
  expect(slices).toEqual(one);
});

/** Worst gap of a 1 ms ticker in a child that runs `work` on a 200k-event database. */
function worstGap(name: string, work: string): number {
  const p = join(dir, `gap-${name}.db`);
  Bun.spawnSync([process.execPath, "--eval", seed(p, EVENTS)], { cwd: join(import.meta.dir, ".."), stderr: "inherit" });
  const out = child(p, `
    // As in the server: the checkpoint worker owns checkpoints, not the commit on this loop.
    startCheckpointer();
    let last = performance.now(), worst = 0;
    const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 1);
    await new Promise((r) => setTimeout(r, 500)); last = performance.now(); worst = 0;
    ${work}
    await new Promise((r) => setTimeout(r, 5)); // let a tick land after a pass that never yielded
    clearInterval(tick);
    process.stdout.write(String(Math.round(worst)));`);
  return Number(out);
}

test("the event loop is never held by the retention delete or the session backfill", () => {
  const prune = worstGap("prune", `await pruneOldRowsYielding();`);
  const fill = worstGap("fill", `await backfillSessionPaths();`);
  if (process.env.AGX_MEASURE_BEFORE) {
    const sql = (c: string) => `db.exec((await import(${JSON.stringify(DB_URL)})).sessionBackfillSql("${c}"));`;
    console.log(`[measure] BEFORE (one pass): retention ${worstGap("prune1", "pruneOldRows();")} ms, backfill ${worstGap("fill1", sql("project_path") + sql("cwd_path"))} ms`);
  }
  console.log(`[measure] worst loop gap over ${EVENTS} events: retention ${prune} ms, backfill ${fill} ms`);
  // The one pass held it 2.6-4.1 s. What is left is the checkpoint worker's lock and GC, not a slice
  // (a slice is under 30 ms), so this in-process proxy gets headroom the /health test below does not.
  expect(prune, "retention held the loop").toBeLessThan(300);
  expect(fill, "the backfill held the loop").toBeLessThan(300);
}, 120_000);

test("a health ping is answered within 150 ms while the boot retention delete runs", async () => {
  const dbPath = join(dir, "big.db");
  const made = Bun.spawnSync([process.execPath, "--eval", seed(dbPath, EVENTS)], { cwd: join(import.meta.dir, ".."), stderr: "inherit" });
  expect(made.exitCode).toBe(0);
  const root = join(dir, "code", "acme");
  mkdirSync(root, { recursive: true });
  const base = `http://127.0.0.1:${await freePort()}`;
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMPDIR: process.env.TMPDIR ?? "/tmp", HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_ROOT: root, AGENTGLASS_DB: dbPath,
      AGENTGLASS_PROJECTS_DIR: join(dir, "projects"), AGENTGLASS_RETENTION_DAYS: "7", AGENTGLASS_PORT: new URL(base).port,
    },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(base + "/health")).ok; } catch { await Bun.sleep(100); } }
    expect(up, "server did not start").toBe(true);
    const peek = new Database(dbPath, { readonly: true });
    const left = () => { try { return (peek.query("SELECT COUNT(*) n FROM events").get() as { n: number }).n; } catch { return -1; } };
    let worst = 0;
    const deadline = performance.now() + 120_000;
    // A read can fail while the server holds the write lock (-1): that is "unknown", not "done",
    // and a full-suite run hit it and stopped the loop with the prune still going.
    const busy = (n: number) => n === -1 || n > 50;
    while (performance.now() < deadline && busy(left())) {
      const s = performance.now();
      expect((await fetch(base + "/health")).ok).toBe(true);
      worst = Math.max(worst, performance.now() - s);
      await Bun.sleep(5);
    }
    let final = left();
    for (let i = 0; i < 50 && final === -1; i++) { await Bun.sleep(100); final = left(); }
    peek.close();
    console.log(`[measure] worst /health while retention deletes ${EVENTS} events: ${Math.round(worst)} ms`);
    expect(final, "the prune did not finish").toBe(50);
    expect(worst, "a health ping was held by the retention delete").toBeLessThan(150);
  } finally { try { proc.kill(); } catch { /* gone */ } }
}, SERVER_BOOT_MS + 150_000);

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });
