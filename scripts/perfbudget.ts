#!/usr/bin/env bun
/**
 * Does the server still answer while it works?
 *
 * The terminal's PTY rides the same single thread as every git call, docker
 * call and SQLite query this process makes, so "the event loop was busy for
 * 900ms" and "the terminal was dead for 900ms" are the same sentence. An
 * afternoon went into making that stop being true — four sync git reads
 * converted, a filter query that blocked 1432ms cached, a network call taken
 * off the thread, a scope filter that expanded to seventy-two predicates
 * rewritten — and none of it is protected by anything. The next `git()` on a
 * poll path undoes it silently, because every other check in this repo passes:
 * tsc is happy, the tests pass, the bundle boots. Only the clock disagrees.
 *
 * So this measures the clock. It pings a route that does no work at all while
 * driving the endpoints the panels poll, and fails if the loop stops answering
 * for longer than a keystroke can wait.
 *
 *   bun scripts/perfbudget.ts             # against a fixture repo it builds
 *   AGX_PERF_ROOT=~/code/big bun …        # against a real one, for a fair fight
 */

import { spawn } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");

/**
 * The budget.
 *
 * 120ms is where typing stops feeling immediate — under it a keystroke lands in
 * the same blink, over it the echo is visibly late. The watchdog in the server
 * uses the same number for the same reason. p99 rather than max: one 150ms
 * hiccup from the OS scheduler is not a regression, and a check that fails on
 * those gets muted, which is worse than not having it.
 */
const BUDGET_MS = 120;
const PING_EVERY_MS = 20;

/** A repo with several worktrees — the shape that made every one of these slow.
 *  A single-checkout fixture would pass this check with the bugs still in. */
function buildRepo(base: string): string {
  const repo = join(base, "orbit");
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "# orbit\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "first");
  for (let i = 1; i <= 8; i++) {
    const b = `WEB-${1000 + i}`;
    g(repo, "worktree", "add", "-q", "-b", b, join(base, `orbit-${b}`));
    writeFileSync(join(base, `orbit-${b}`, `${b}.txt`), "work\n");
    g(join(base, `orbit-${b}`), "add", "-A");
    g(join(base, `orbit-${b}`), "commit", "-qm", `work on ${b}`);
  }
  // Something uncommitted, so the dirty counts have work to do.
  writeFileSync(join(repo, "scratch.txt"), "in progress\n");
  return repo;
}

const base = mkdtempSync(join(tmpdir(), "agx-perf-"));
const home = mkdtempSync(join(tmpdir(), "agx-perf-home-"));
const repo = process.env.AGX_PERF_ROOT || buildRepo(base);
const port = 4960 + Math.floor(Math.random() * 30);
const S = `http://127.0.0.1:${port}`;
const R = encodeURIComponent(repo);

const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port),
    AGENTGLASS_ROOT: repo,
    AGENTGLASS_DB: join(home, "perf.db"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    AGENTGLASS_TOKEN: "",
    // The transcript sweep reads whatever is in the operator's ~/.claude, which
    // is neither this app's doing nor reproducible on a CI runner.
    AGENTGLASS_SCAN_DISABLED: "1",
    // Arm the server's parent-death watchdog. The finally below kills it on a
    // clean exit, but if this script is SIGKILLed the server is reparented to
    // init and would otherwise linger holding the port — the watchdog reaps it.
    AGENTGLASS_DIE_WITH_PARENT: "1",
  },
  stdout: "ignore",
  stderr: "inherit",
});

// SIGTERM/SIGINT skip the finally below, so a Ctrl-C or a `kill` on this script
// would leave the server it spawned running. Kill it on the way out ourselves;
// the watchdog is the backstop for the harder SIGKILL case only.
for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => { try { server.kill(); } catch { /* already gone */ } process.exit(1); });
}

const lat: number[] = [];
let stop = false;
const pinger = (async () => {
  while (!stop) {
    const a = performance.now();
    try { await fetch(`${S}/__perfping__`); } catch { /* between requests */ }
    lat.push(performance.now() - a);
    await Bun.sleep(PING_EVERY_MS);
  }
})();

/** What the panels ask for while you are looking at them. */
const POLLED = [
  `/git/tree?root=${R}`,
  `/git/repos`,
  `/git/branches?root=${R}`,
  `/git/graph?root=${R}&limit=500&scope=head`,
  `/git/worktrees?root=${R}`,
  `/git/tags?root=${R}`,
  `/events/filter-options`,
  `/sessions?limit=100`,
  `/stats?window=3600000`,
  `/skills`,
];

let failed = false;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${S}/health`)).ok) break; } catch { /* booting */ }
    await Bun.sleep(250);
  }
  await Bun.sleep(500);
  lat.length = 0; // boot is not what is under test

  // One pass to warm, then a realistic stretch: the panels re-poll every couple
  // of seconds while you look at them, so that is what this does — for long
  // enough that the percentiles mean something. Three samples make a p99 that
  // is just the worst number you happened to see.
  await Promise.all(POLLED.map((p) => fetch(S + p).then((r) => r.text()).catch(() => "")));
  await Bun.sleep(300);
  lat.length = 0;

  const t0 = performance.now();
  const MEASURE_MS = 6_000;
  let rounds = 0;
  while (performance.now() - t0 < MEASURE_MS) {
    await Promise.all(POLLED.map((p) => fetch(S + p).then((r) => r.text()).catch(() => "")));
    rounds++;
    await Bun.sleep(400);
  }
  stop = true;
  await pinger;

  const ms = [...lat].sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor((q / 100) * ms.length))] ?? 0;
  console.log(`served ${POLLED.length} endpoints × ${rounds} rounds over ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`loop meanwhile: ${ms.length} samples · p50 ${p(50).toFixed(1)}ms · p95 ${p(95).toFixed(1)}ms · p99 ${p(99).toFixed(1)}ms · max ${(ms.at(-1) ?? 0).toFixed(0)}ms`);

  if (ms.length < 50) {
    console.log(`\n✗ perf: only ${ms.length} samples — the probe never got going, so this proved nothing`);
    failed = true;
  }
  // p99 is the budget; max is allowed one worse moment, because the OS
  // scheduler gets a vote and a check that fails on those gets muted.
  if (p(99) > BUDGET_MS) {
    console.log(`\n✗ perf: p99 loop delay ${p(99).toFixed(0)}ms is over the ${BUDGET_MS}ms budget`);
    console.log("  Something on a polled path is holding the event loop. The server's own");
    console.log("  watchdog will name it: GET /api/loopwatch on a running instance.");
    failed = true;
  } else if ((ms.at(-1) ?? 0) > BUDGET_MS * 4) {
    console.log(`\n✗ perf: one ${(ms.at(-1) ?? 0).toFixed(0)}ms freeze — rare, but that is a terminal that stopped for a third of a second`);
    failed = true;
  } else {
    console.log(`\n✓ perf: the loop stays answerable (p99 ${p(99).toFixed(0)}ms, budget ${BUDGET_MS}ms)`);
  }
} finally {
  stop = true;
  try { server.kill(); } catch { /* already gone */ }
  rmSync(home, { recursive: true, force: true });
  if (!process.env.AGX_PERF_ROOT) rmSync(base, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
