/*
 * GET /spend/today THROUGH A RESTART.
 *
 * The Orchestration page's "Today" read the cost off the board's live rows, and
 * a row takes its cost with it when its worker leaves: the same day showed what
 * had been spent, then $0.00 after the server was restarted. The number is a
 * day and a project in the stored events, so it has to read the same on both
 * sides of a boot.
 *
 * Booted the way the other route tests boot, and stopped and booted again on
 * the same database — that second boot is the whole point of this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-spend-today-"));
const DB = join(dir, "spend.db");
const ROOT = join(dir, "code", "orbit");
const OTHER = join(dir, "code", "ledger");
const TODAY_USD = 1.22;
/** Yesterday, in the same UTC day arithmetic the route uses. */
const YESTERDAY_MS = Date.now() - 86_400_000;

let base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

function boot() {
  return Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      // State, config and the database jailed: a booted server must not write
      // into the developer's own ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: DB,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: new URL(base).port,
    },
    stdout: "ignore", stderr: "pipe",
  });
}

async function up(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

const today = async (root: string): Promise<{ ok: boolean; day?: string; usd?: number }> =>
  (await fetch(`${base}/spend/today?root=${encodeURIComponent(root)}`)).json() as Promise<{ ok: boolean; day?: string; usd?: number }>;

/** What today has cost this project, as the page reads it once the server is up. */
const readToday = async (): Promise<number | null> => {
  const r = await today(ROOT);
  return typeof r.usd === "number" ? r.usd : null;
};

/** The fixture: today's $1.22 for this project, plus a row on each side of the
 *  day and project boundary that the answer must not include. Idempotent, so a
 *  test that runs first can seed for itself rather than inherit a read. */
let seeded = false;
async function seed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  // Today, through the door the hooks use. The cost is what the sender
  // reported, so the assertion does not depend on a price table.
  const r = await fetch(base + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_app: "orbit", session_id: "s-today", hook_event_type: "Stop",
      model_name: "claude-sonnet-5", reported_cost_usd: TODAY_USD,
      payload: { project_path: ROOT },
    }),
  });
  expect((await r.json() as { ok: boolean }).ok).toBe(true);

  // Yesterday's, and today's from another project, written straight into the
  // tables the route reads: /ingest clamps a skewed clock to now, which is
  // right for a sender and useless for a day boundary.
  const db = new Database(DB);
  db.run("INSERT INTO events (source_app, session_id, hook_event_type, timestamp, cost_usd, payload) VALUES (?, ?, ?, ?, ?, ?)",
    ["orbit", "s-yesterday", "Stop", YESTERDAY_MS, 5, JSON.stringify({ project_path: ROOT })]);
  db.run("INSERT INTO events (source_app, session_id, hook_event_type, timestamp, cost_usd, payload) VALUES (?, ?, ?, ?, ?, ?)",
    ["ledger", "s-other", "Stop", Date.now(), 7, JSON.stringify({ project_path: OTHER })]);
  db.close();
}

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(OTHER, { recursive: true });
  base = `http://127.0.0.1:${await freePort()}`;
  proc = boot();
  await up();
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("/spend/today", () => {
  test("today's spend is the stored day's, and yesterday's and another project's are not in it", async () => {
    await seed();
    expect(await readToday()).toBeCloseTo(TODAY_USD, 2);
  });

  test("the same number comes back after a restart", async () => {
    await seed();
    const before = await readToday();
    expect(before).toBeCloseTo(TODAY_USD, 2);

    // Nothing about the day changed but the process: this is where the old
    // reading went to $0.00, because the board's rows were the number.
    proc?.kill();
    await proc?.exited;
    proc = boot();
    await up();

    expect(await readToday()).toBeCloseTo(before!, 2);
  }, 30_000);
});
