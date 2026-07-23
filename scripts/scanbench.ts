#!/usr/bin/env bun
/**
 * How long does ONE transcript sweep block the event loop?
 *
 * The scanner runs on the single thread that also pumps the terminal's PTY, so
 * "the sweep was busy for 900ms" and "the terminal was frozen for 900ms" are the
 * same sentence. `loadtest.ts --heavy` proves the *symptom* (a stuttering PTY)
 * end to end through a real server and socket; this proves the *cause* in
 * isolation, deterministically, with no server and no network in the way.
 *
 * It builds a big /tmp fixture (many tens-of-MB transcripts full of multi-MB
 * base64-image lines — never the operator's real ~/.claude), arms a 5ms
 * heartbeat, runs a single `scanOnce`, and reports the worst gap the heartbeat
 * saw: the longest stretch the loop was unavailable in one shot. Under the fix
 * that number is a keystroke; before it, it is the whole file.
 *
 *   bun scripts/scanbench.ts
 *   AGX_TX_FILES=8 AGX_TX_FILE_MB=80 bun scripts/scanbench.ts   # heavier
 */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHeavyTranscripts, HEAVY_DEFAULTS } from "./heavytx.ts";

const base = mkdtempSync(join(tmpdir(), "agx-scanbench-"));
const projects = join(base, "projects");
const cwd = join(base, "repo"); // a real dir so projectOf() resolves it
mkdirSync(cwd, { recursive: true });

// Point the scanner at the fixture and keep everything else off the real HOME.
// Set BEFORE importing the modules: transcripts.ts reads the projects dir per
// sweep (so a late set would still work), but db.ts opens its file at import.
process.env.AGENTGLASS_PROJECTS_DIR = projects;
process.env.AGENTGLASS_DB = join(base, "scan.db");
process.env.AGENTGLASS_ROOT = ""; // unscoped: ingest everything, no scope filter
process.env.HOME = base; // belt-and-suspenders: nothing reaches ~/.claude
process.env.XDG_DATA_HOME = join(base, "data");
process.env.XDG_CONFIG_HOME = join(base, "config");
process.env.XDG_CACHE_HOME = join(base, "cache");

const opts = { ...HEAVY_DEFAULTS, cwd };
console.log(`building fixture: ${opts.files} files × ~${opts.fileMb}MB (giant lines ${opts.giantLineMb}MB, medium ${opts.mediumLineKb}KB)…`);
const t0 = performance.now();
const built = buildHeavyTranscripts(projects, opts);
console.log(
  `built ${(built.bytes / 1_048_576).toFixed(0)}MB across ${built.files.length} files (${built.lines} lines) in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`
);

const scan = await import("../server/src/transcripts.ts");
const dbmod = await import("../server/src/db.ts");

// A fine-grained heartbeat. Every HB_MS we expect to run HB_MS after last time;
// anything more is the loop having been blocked. A synchronous JSON.parse block
// makes these callbacks queue and fire late — the lateness IS the block.
const HB_MS = 5;
let last = performance.now();
let worst = 0;
let stalls = 0;
let stalledMs = 0;
const STALL = 20; // a gap over this is a stall a human would feel
const hb = setInterval(() => {
  const now = performance.now();
  const drift = now - last - HB_MS;
  last = now;
  if (drift > STALL) {
    stalls++;
    stalledMs += drift;
    if (drift > worst) worst = drift;
  }
}, HB_MS);

const before = dbmod.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM events").get()?.n ?? 0;
console.log("running one scanOnce over the backlog…");
const s0 = performance.now();
const ingested = await scan.scanOnce(null);
const wall = performance.now() - s0;
clearInterval(hb);
const after = dbmod.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM events").get()?.n ?? 0;

console.log(`\n— one sweep over ${(built.bytes / 1_048_576).toFixed(0)}MB —`);
console.log(`  wall           ${(wall / 1000).toFixed(2)}s`);
console.log(`  events ingested ${ingested} (rows +${after - before})`);
console.log(`  worst single loop stall  ${worst.toFixed(0)}ms   ← the longest the PTY would freeze in one shot`);
console.log(`  stalls >${STALL}ms         ${stalls} · total blocked ${stalledMs.toFixed(0)}ms of ${wall.toFixed(0)}ms wall`);

// Budget: no single synchronous block may exceed the PTY's frozen-terminal line.
// 120ms is the loop watchdog's own STALL_MS; a sweep that never blocks longer
// than that never freezes the console for a noticeable beat.
const BUDGET = Number(process.env.AGX_SCAN_BUDGET_MS || 120);
let failed = false;
console.log("");
if (worst > BUDGET) {
  console.log(`✗ scanbench: a single sweep blocked the loop ${worst.toFixed(0)}ms — over the ${BUDGET}ms budget, the terminal would freeze for that long`);
  failed = true;
} else {
  console.log(`✓ scanbench: no single loop stall over ${BUDGET}ms (worst ${worst.toFixed(0)}ms) — the sweep yields the thread`);
}

rmSync(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
