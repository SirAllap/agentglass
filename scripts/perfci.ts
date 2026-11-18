/**
 * `make perf-ci`: the isolated agents load (scripts/loadagents.ts, fake agents
 * on their own tmux socket -L agx-load and their own DB) at a size a CI runner
 * can carry, and a verdict on the JSON it writes.
 *
 * THE THRESHOLDS LIVE HERE, in LIMITS, and nowhere else.
 *
 * Measured on a laptop on 2026-11-11 with 90 agents: 1 server stall of ~230 ms,
 * echo p99 ~22-34 ms, every panel route <= 240 ms. The limits are several times
 * that on purpose: a shared runner is slower and noisier than a laptop, and this
 * gate exists to catch a loop that FREEZES (a sync spawn, a disk wait), not to
 * grade a 10 % drift. Tighten them once a few CI runs show the real spread.
 *
 *   AGX_LOAD_OUT=file.json    where the result goes (default perf-ci-result.json)
 *   AGX_LOAD_SECONDS=45       measure window (default 45); AGX_LOAD_AGENTS etc. override too
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const LIMITS = {
  /** Longest stretch the server's event loop may stand still (watchdog, log and external ping). */
  stall_max_ms: 1000,
  /** p99 of a keystroke's echo through the real terminal WebSocket. */
  echo_p99_ms: 150,
  /** Worst p95 over every panel route the window polls (agent board, sessions, git...). */
  panel_p95_ms: 1500,
};

const ROOT = resolve(import.meta.dir, "..");
const out = resolve(process.env.AGX_LOAD_OUT || join(ROOT, "perf-ci-result.json"));
if (existsSync(out)) rmSync(out);

const proc = Bun.spawn(["bun", join(ROOT, "scripts", "loadtest.ts")], {
  stdout: "inherit", stderr: "inherit",
  env: {
    ...process.env,
    AGX_LOAD_AGENTS: process.env.AGX_LOAD_AGENTS || "20",
    AGX_LOAD_TABS: process.env.AGX_LOAD_TABS || "10", // desk tabs (root=), not the phone's pane=
    AGX_LOAD_PANELS: process.env.AGX_LOAD_PANELS || "1",
    AGX_LOAD_FLOOD: process.env.AGX_LOAD_FLOOD || "2",
    AGX_LOAD_SECONDS: process.env.AGX_LOAD_SECONDS || "45",
    AGX_LOAD_TX_MB: process.env.AGX_LOAD_TX_MB || "20",
    AGX_LOAD_OUT: out,
  },
});
const code = await proc.exited;
if (!existsSync(out)) { console.error(`perf-ci: harness (exit ${code}) wrote no result at ${out}`); process.exit(1); }

const r = JSON.parse(readFileSync(out, "utf8")) as Record<string, any> | null;
if (!r) { console.error("perf-ci: empty result"); process.exit(1); }
const routes = Object.values((r.routes ?? {}) as Record<string, { p95?: number }>);
const got = {
  // The measured window only: log_max_ms is the worst since boot, and boot's own
  // stall (609 ms on a laptop, more on a runner) is not what this guards.
  stall_max_ms: Math.max(r.loop_stall_server?.max ?? 0, r.loop_ping?.max ?? 0),
  echo_p99_ms: r.echo?.p99 ?? Infinity,
  panel_p95_ms: routes.length ? Math.max(...routes.map((x) => x.p95 ?? 0)) : Infinity, // no routes = panels did not run = not proved
};
let failed = false;
console.log("\nperf-ci verdict");
for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
  const over = !(got[k] <= LIMITS[k]);
  if (over) failed = true;
  console.log(`  ${over ? "✗" : "✓"} ${k} ${Number.isFinite(got[k]) ? Math.round(got[k]) : "no data"} / limit ${LIMITS[k]}`);
}
// The harness's own verdict (too few echo samples, crash) counts too.
if (code !== 0) { console.log(`  ✗ harness exited ${code}`); failed = true; }
process.exit(failed ? 1 : 0);
