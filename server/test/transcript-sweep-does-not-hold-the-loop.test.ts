/*
 * The transcript sweep must not freeze the server while it looks for files.
 *
 * Before it opens anything the 3s sweep walks every project directory and stats
 * every transcript on disk, synchronously. On a real machine's
 * `~/.claude/projects` that was the 3,678 ms the loop watchdog attributed to the
 * sweep (150 pages in the log): thousands of cold stats, and no route or
 * keystroke answered until they finished.
 *
 * The fixture is dropped in while the server is already up, so what is measured
 * is the sweep and not the boot: the next tick finds two hundred thousand
 * transcripts and has to stat every one of them before it reads a line.
 * Measured from outside, like the git panel — a /health request fired over and
 * over across that tick, and the worst one has to stay fast.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-scan-loop-"));
const PROJECTS = join(dir, "projects");
const ROOT = join(dir, "code", "acme");
/** Directories times transcripts per directory: the walk the sweep pays for
 *  before it reads a single line. */
const DIRS = 400;
const FILES = 500;
/** The one transcript in the fixture that is inside the open project, so the
 *  sweep writes a `transcript_files` row for it and the test can tell a walk
 *  that saw the whole fixture has finished. Written last, and in its own
 *  project directory, so no sweep started before the fixture can reach it. */
const MARKER = join(PROJECTS, "-code-acme-marker", "f-marker.jsonl");

let base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let markerDb: Database | null = null;

/** True once the sweep has finished walking the fixture and read the marker. */
function sweepSawTheFixture(): boolean {
  try {
    return !!markerDb?.query("SELECT 1 AS one FROM transcript_files WHERE path = ?").get(MARKER);
  } catch {
    return false; // the table is created on the server's first write
  }
}

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(PROJECTS, { recursive: true });
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
      AGENTGLASS_DB: join(dir, "scan.db"),
      AGENTGLASS_PROJECTS_DIR: PROJECTS,
      AGENTGLASS_SCAN_INTERVAL_MS: "500",
      AGENTGLASS_PORT: new URL(base).port,
    },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) throw new Error("server did not start");
  markerDb = new Database(join(dir, "scan.db"));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { markerDb?.close(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

test("a health ping is answered while a sweep walks the transcripts", async () => {
  // In a child, so the names this test hands the sweep are not garbage the test
  // process has to collect while it is measuring the server.
  const script = join(dir, "make-fixture.ts");
  writeFileSync(script, `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const line = JSON.stringify({ type: "user", cwd: "/elsewhere/orbit", sessionId: "s-x", message: { role: "user", content: "hi" } }) + "\\n";
    for (let d = 0; d < ${DIRS}; d++) {
      const p = join(process.env.PROJECTS!, "-elsewhere-orbit-" + d);
      mkdirSync(p, { recursive: true });
      for (let f = 0; f < ${FILES}; f++) writeFileSync(join(p, "f-" + f + ".jsonl"), line);
    }
    // Last, on purpose: see MARKER in the test.
    const marker = join(process.env.PROJECTS!, "-code-acme-marker");
    mkdirSync(marker, { recursive: true });
    writeFileSync(join(marker, "f-marker.jsonl"), JSON.stringify({
      type: "user", cwd: ${JSON.stringify(ROOT)}, sessionId: "s-marker",
      message: { role: "user", content: "hi" },
    }) + "\\n");
  `);
  const made = Bun.spawnSync(["bun", script], { env: { ...process.env, PROJECTS }, stdout: "ignore", stderr: "inherit" });
  expect(made.exitCode, "fixture not created").toBe(0);

  /* Ping until a sweep that saw the fixture has finished walking it.
   *
   * A fixed window cannot do this: writing the fixture takes seconds, so a tick
   * that lands early starts a walk over a directory that is still being filled,
   * and the walk this guard exists to catch can begin after the window has
   * closed — which is how this test read green on the synchronous walk. The
   * queue is built in full before one file is read, so a row for the marker
   * transcript proves the walk that could see it is over. The pings run through
   * all of it, so the worst one covers the walk either way. */
  let healthMs = 0;
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline && !sweepSawTheFixture()) {
    const s = performance.now();
    const h = await fetch(base + "/health");
    const took = performance.now() - s;
    expect(h.ok).toBe(true);
    if (took > healthMs) healthMs = took;
    await Bun.sleep(10);
  }
  const walked = sweepSawTheFixture();
  console.log(`[measure] worst /health while the sweep walks ${DIRS * FILES} transcripts: ${Math.round(healthMs)} ms (walk finished: ${walked})`);
  expect(walked, "no sweep finished walking the fixture").toBe(true);
  expect(healthMs, "a health ping was held by the sweep").toBeLessThan(150);
}, 180_000);
