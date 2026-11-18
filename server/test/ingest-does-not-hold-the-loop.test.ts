/*
 * POST /ingest must not freeze the server while it works.
 *
 * The hook fires on every tool call, and the open-tool push that rides each
 * Pre/Post reads the evidence of life for up to 200 calls: one stat per
 * session's transcript and one scan of up to 400 entries for every working
 * directory, all with statSync/readdirSync. On a cold page cache that is
 * thousands of blocking stats on the one thread every route and the terminal
 * share; a log from a real cockpit has it at 11,945 ms.
 *
 * Measured the way the git panel is: a request that does no work must come
 * back while the slow one is still running. A passing ingest is not enough —
 * the answer has to arrive before the block, not after it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-ingest-loop-"));
const DB = join(dir, "ingest.db");
const ROOT = join(dir, "code", "acme");
/** At the two ceilings the evidence collector works under: 200 open calls,
 *  400 directory entries each. */
const CALLS = 200;
const ENTRIES = 400;

let base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  for (let i = 0; i < CALLS; i++) {
    const d = join(ROOT, `wt-${i}`);
    mkdirSync(d, { recursive: true });
    for (let f = 0; f < ENTRIES; f++) writeFileSync(join(d, `f-${f}.txt`), "x");
  }
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

  // The open calls the hook would have left behind: one Bash per worktree, no
  // Post after it. Written straight into the tables so the fixture is the
  // evidence collector's workload rather than 200 HTTP round trips.
  const db = new Database(DB);
  const ins = db.prepare(
    "INSERT INTO events (source_app, session_id, hook_event_type, tool_name, tool_use_id, payload, timestamp) VALUES (?,?,?,?,?,?,?)"
  );
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < CALLS; i++) {
      ins.run("acme", `s-${i}`, "PreToolUse", "Bash", `tu-${i}`,
        JSON.stringify({ project_path: ROOT, cwd: join(ROOT, `wt-${i}`) }), now - i);
    }
  })();
  db.close();
}, 120_000);

afterAll(() => {
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

test("a health ping lands while the ingest is still scanning", async () => {
  // A window is connected (the board is open), which is when the push runs.
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: "ingest-loop" }));
  await Bun.sleep(5);

  const t0 = performance.now();
  const ingest = fetch(base + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_app: "acme", session_id: "s-live", hook_event_type: "PreToolUse",
      tool_name: "Bash", tool_use_id: "tu-live",
      payload: { project_path: ROOT, cwd: join(ROOT, "wt-0") },
    }),
  }).then(async (r) => {
    const took = performance.now() - t0;
    return { took, body: (await r.json()) as { ok: boolean } };
  });

  // The scan this POST asks for runs for a few hundred milliseconds after it.
  // The ping has to be answered inside that window, not after it.
  let healthMs = 0;
  const until = performance.now() + 600;
  while (performance.now() < until) {
    const s = performance.now();
    const h = await fetch(base + "/health");
    const took = performance.now() - s;
    expect(h.ok).toBe(true);
    if (took > healthMs) healthMs = took;
    await Bun.sleep(10);
  }
  const answer = await ingest;
  ws.close();
  console.log(`[measure] /ingest ${Math.round(answer.took)} ms, worst /health during the scan ${Math.round(healthMs)} ms`);
  expect(answer.body.ok).toBe(true);
  expect(answer.took, "the hook waited for the scan").toBeLessThan(150);
  expect(healthMs, "a health ping was held").toBeLessThan(150);
}, 120_000);

/*
 * A socket that connects while the snapshot is being assembled must not be
 * handed a live frame first: the client clears everything it queued the moment
 * `initial` arrives (web/src/lib/useLive.ts), so a Pre that lands in that
 * window would lose its card and a Post would lose its closing.
 */
test("a new socket's first frame is `initial`, even while an ingest is in flight", async () => {
  const frames: string[] = [];
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  ws.addEventListener("message", (ev) => {
    try { frames.push(String((JSON.parse(String(ev.data)) as { type?: string }).type ?? "")); } catch { /* not ours */ }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  // The open handler is now reading evidence for the 200 open calls above,
  // which is the window a live broadcast can slip into.
  await Bun.sleep(20);

  const r = await fetch(base + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_app: "acme", session_id: "s-order", hook_event_type: "PreToolUse",
      tool_name: "Bash", tool_use_id: "tu-order",
      payload: { project_path: ROOT, cwd: join(ROOT, "wt-0") },
    }),
  });
  expect(((await r.json()) as { ok: boolean }).ok).toBe(true);

  const until = performance.now() + 30_000;
  while (!frames.includes("initial") && performance.now() < until) await Bun.sleep(10);
  ws.close();
  console.log(`[measure] first frames on a socket opened mid-scan: ${frames.slice(0, 3).join(", ")}`);
  expect(frames[0], "a broadcast reached the socket before its snapshot").toBe("initial");
}, 120_000);
