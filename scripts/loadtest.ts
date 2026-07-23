#!/usr/bin/env bun
/**
 * Does the terminal stay typeable while the panels hammer the server?
 *
 * `perfbudget.ts` proved the *loop* stays answerable, but it does it against a
 * fixture repo and an empty DB with a handful of endpoints on a gentle poll —
 * the calm case. The bug the user actually feels is the loud one: the real
 * 186MB database loaded, a repo with eighteen worktrees, and *several* panels
 * across *several* clients all polling git, docker, PRs, stats and the gate at
 * once. Under that the sidecar was seen at 72% sustained CPU with the spawn
 * pool pinned (peakInflight 16 / peakWaiting 16), and the in-browser terminal
 * stuttered — a keystroke's echo arriving a third of a second late.
 *
 * So this reproduces *that*, and measures the one number that is the bug: how
 * long the PTY takes to echo a keystroke while the fan-out runs. It also reports
 * the pure loop delay (an external ping), the server's own stall log with the
 * name of whatever blocked it (/api/loopwatch), the spawn-pool high-water marks,
 * and the sidecar's CPU — so a failure names its cause instead of just failing.
 *
 * Two properties make its numbers trustworthy:
 *   * The DB is a COPY of the real one (never the original, never in write), so
 *     the database cost is realistic — an empty DB is why `make perf` never
 *     reproduced the stutter.
 *   * The load and the measurement run in SEPARATE processes. The panel fan-out
 *     is dozens of concurrent fetches; run in the same event loop as the PTY
 *     probe it would starve the probe's own timers and the harness would be
 *     measuring itself. So a child process generates the load and this one only
 *     watches the terminal — the delay it sees is the server's, not its own.
 * The copy, the fixture repo, the child and the server are all torn down on exit.
 *
 *   make loadtest                          # 6 clients, real DB copy, 18-worktree fixture
 *   AGX_LOAD_CLIENTS=10 make loadtest      # heavier
 *   AGX_LOAD_ROOT=~/code/big make loadtest # against a real repo instead of the fixture
 *   AGX_LOAD_DB=/path/to.db make loadtest  # a specific DB to copy (default: the real one)
 *   AGX_LOAD_SECONDS=20 make loadtest      # longer measure window
 *   AGX_LOAD_ONLY=git / AGX_LOAD_SKIP=git  # bisect: which fan-out causes the stutter
 */
import { spawn } from "bun";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");

// --- knobs (identical in the parent and the load child) ----------------------
const CLIENTS = Math.max(1, Number(process.env.AGX_LOAD_CLIENTS || 6));
const WORKTREES = Math.max(1, Number(process.env.AGX_LOAD_WORKTREES || 18));
const MEASURE_MS = Math.max(3_000, Number(process.env.AGX_LOAD_SECONDS || 15) * 1000);
/** How long a client waits between one full fan-out burst and the next. Each
 *  burst fires every panel endpoint at once, so CLIENTS × ROUND is the real
 *  concurrency the server sees. 700ms with 6 clients puts ~30 subprocess-backed
 *  requests in flight at a time — the shape that pinned the spawn pool. */
const ROUND_MS = Math.max(100, Number(process.env.AGX_LOAD_ROUND_MS || 700));
/** A keystroke every this often. ~11/s is fast human typing, dense enough that
 *  the percentiles mean something over a 15s window. */
const KEYSTROKE_MS = Math.max(30, Number(process.env.AGX_LOAD_KEYSTROKE_MS || 90));
/**
 * A ceiling on any one request, so a burst always completes.
 *
 * Under a saturated spawn pool a single git/docker/gh read can queue for many
 * seconds; without a cap a burst waits on the slowest of fourteen and never
 * ends. A timed-out read is real load either way — it took a slot, it just
 * isn't waited on past the point of usefulness — so it is caught. This is the
 * client backing off as a browser tab's fetch would, not a way to flatter the
 * numbers.
 */
const REQ_TIMEOUT_MS = Math.max(1_000, Number(process.env.AGX_LOAD_REQ_TIMEOUT_MS || 8_000));
/**
 * The budget. This is echo latency — a keystroke's round trip through the PTY —
 * not pure loop delay, so it carries the shell's own handling and the localhost
 * socket on top of whatever the loop was doing. 250ms is the point past which
 * the terminal reads as laggy rather than instant; the loop watchdog's own line
 * is 120ms, and echo sits a notch above it by construction.
 */
const PTY_P99_BUDGET_MS = Math.max(1, Number(process.env.AGX_LOAD_PTY_P99_MS || 250));

// --- the panel fan-out: every endpoint a client polls while panels are open --
// At the cadence the web app uses (GitPanel tree 2.5s / views 10s, DockerPanel
// 5s, PrPanel 20s, Sessions 5s, gate 2s, stats 4s). Rather than juggle a dozen
// timers per client, each client fires the whole set in one burst and sleeps
// ROUND_MS — the concurrency being tested comes from CLIENTS bursts overlapping,
// which is what a handful of open tabs produces.
function buildGets(R: string): string[] {
  let gets = [
    `/git/tree?root=${R}`,
    `/git/repos`,
    `/git/branches?root=${R}`,
    `/git/worktrees?root=${R}`,
    `/git/graph?root=${R}&limit=500&scope=head`,
    `/git/tags?root=${R}`,
    `/docker/overview`,
    `/docker/stats`,
    `/prs/list?root=${R}&filter=mine`,
    `/stats?window=3600000`,
    `/sessions?limit=100`,
    `/events/filter-options`,
    `/gate/pending`,
  ];
  // Bisect knobs: keep only endpoints whose path contains AGX_LOAD_ONLY, drop
  // any containing AGX_LOAD_SKIP. `AGX_LOAD_ONLY=git` reproduces with git alone;
  // `AGX_LOAD_SKIP=git` proves it is the git fan-out by taking it away.
  const only = process.env.AGX_LOAD_ONLY;
  const skip = process.env.AGX_LOAD_SKIP;
  if (only) gets = gets.filter((p) => p.includes(only));
  if (skip) gets = gets.filter((p) => !p.includes(skip));
  return gets;
}
function withStatusEndpoint(): boolean {
  const only = process.env.AGX_LOAD_ONLY;
  const skip = process.env.AGX_LOAD_SKIP;
  return (!only || "/git/status".includes(only)) && !(skip && "/git/status".includes(skip));
}

/** One client's job: fire the whole endpoint set, wait ROUND_MS, repeat. */
function makeBurst(S: string, repo: string): () => Promise<void> {
  const R = encodeURIComponent(repo);
  const GETS = buildGets(R);
  const withStatus = withStatusEndpoint();
  const statusBody = JSON.stringify({ paths: [join(repo, "README.md"), join(repo, "scratch.txt")] });
  const get = (p: string) =>
    fetch(S + p, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }).then((r) => r.text()).catch(() => "");
  return async () => {
    const reqs = GETS.map(get);
    if (withStatus) reqs.push(fetch(`${S}/git/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: statusBody,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    }).then((r) => r.text()).catch(() => ""));
    await Promise.all(reqs);
  };
}

// ============================================================================
// LOAD CHILD. Re-invoked as `AGX_LOAD_WORKER=<serverUrl> bun loadtest.ts`, it is
// nothing but the fan-out: CLIENTS clients bursting until its deadline, so the
// parent's event loop is free to time the terminal without competing with its
// own load. Exits on its own; the parent also kills it as a backstop.
// ============================================================================
if (process.env.AGX_LOAD_WORKER) {
  const S = process.env.AGX_LOAD_WORKER;
  const repo = process.env.AGX_LOAD_REPO || "";
  const runMs = Number(process.env.AGX_LOAD_WORKER_MS || MEASURE_MS) + 5_000; // outlast the measure
  const burst = makeBurst(S, repo);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CLIENTS }, async () => {
    while (performance.now() - t0 < runMs) {
      await burst();
      await Bun.sleep(ROUND_MS);
    }
  }));
  process.exit(0);
}

// ============================================================================
// PARENT. Boots the server, primes the terminal, starts the load child, and
// measures the PTY while it runs.
// ============================================================================

// --- the database under test: a copy of the real one -------------------------
function defaultRealDb(): string {
  const dir = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dir, "agentglass", "agentglass.db");
}
const home = mkdtempSync(join(tmpdir(), "agx-load-home-"));
const dbCopy = join(home, "loadtest.db");
const srcDb = process.env.AGX_LOAD_DB || defaultRealDb();
let dbNote: string;
if (existsSync(srcDb)) {
  // Read-only of the original: copyFileSync reads the source and writes the
  // COPY. The server is only ever pointed at the copy, opened in its own temp
  // home, so the real instance and its file are never touched. WAL mode keeps
  // the main .db consistent at the last checkpoint, so a copy of just the .db
  // is a valid (if slightly-behind) snapshot even if the real server is live.
  copyFileSync(srcDb, dbCopy);
  const mb = (readFileSync(dbCopy).byteLength / 1_048_576).toFixed(0);
  dbNote = `copy of ${srcDb} (${mb}MB)`;
} else {
  dbNote = `empty DB (no ${srcDb} to copy — pass AGX_LOAD_DB for a realistic run)`;
}

// --- a repo with many worktrees: the git fan-out the panels sweep ------------
function buildRepo(baseDir: string): string {
  const repoDir = join(baseDir, "orbit");
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repoDir]);
  g(repoDir, "config", "user.email", "t@example.com");
  g(repoDir, "config", "user.name", "t");
  writeFileSync(join(repoDir, "README.md"), "# orbit\n");
  g(repoDir, "add", "-A");
  g(repoDir, "commit", "-qm", "first");
  for (let i = 1; i <= WORKTREES; i++) {
    const b = `WEB-${1000 + i}`;
    g(repoDir, "worktree", "add", "-q", "-b", b, join(baseDir, `orbit-${b}`));
    writeFileSync(join(baseDir, `orbit-${b}`, `${b}.txt`), "work\n");
    g(join(baseDir, `orbit-${b}`), "add", "-A");
    g(join(baseDir, `orbit-${b}`), "commit", "-qm", `work on ${b}`);
  }
  writeFileSync(join(repoDir, "scratch.txt"), "in progress\n"); // dirty, so counts have work
  return repoDir;
}
const base = mkdtempSync(join(tmpdir(), "agx-load-"));
const repo = process.env.AGX_LOAD_ROOT || buildRepo(base);

const port = 4870 + Math.floor(Math.random() * 60);
const S = `http://127.0.0.1:${port}`;
const WS = S.replace("http", "ws");
const R = encodeURIComponent(repo);

const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port),
    AGENTGLASS_ROOT: repo,
    AGENTGLASS_DB: dbCopy,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    AGENTGLASS_TOKEN: "",
    // The transcript sweep reads the operator's real ~/.claude — not reproducible
    // and, per the diagnosis, not the bottleneck (its tails are incremental).
    // This test is about the git/docker/broadcast fan-out, so keep it out of the
    // picture; set AGENTGLASS_SCAN_DISABLED=0 to fold it back in.
    AGENTGLASS_SCAN_DISABLED: process.env.AGENTGLASS_SCAN_DISABLED ?? "1",
    // The probe shell. What is being measured — how fast the server's single
    // thread pumps PTY bytes while the fan-out runs — is a property of the
    // server, not the shell, so the probe wants the quietest, most deterministic
    // shell available. A fresh-config interactive fish spends its first run
    // generating config and can flood the socket, which is real for a first-ever
    // launch but noise for this test; bash -il in an empty home is silent.
    // Override with AGX_LOAD_SHELL to measure against your actual login shell.
    SHELL: process.env.AGX_LOAD_SHELL || Bun.which("bash") || "/bin/bash",
    // Reap the sidecar if this script is SIGKILLed and can't run its finally.
    AGENTGLASS_DIE_WITH_PARENT: "1",
  },
  stdout: "ignore",
  stderr: "inherit",
});

let loadChild: ReturnType<typeof spawn> | null = null;
function cleanup() {
  try { loadChild?.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
  rmSync(home, { recursive: true, force: true });
  if (!process.env.AGX_LOAD_ROOT) rmSync(base, { recursive: true, force: true });
}
// A Ctrl-C / SIGTERM aimed at this script skips the finally below; kill the
// children ourselves so nothing outlives us. The watchdog covers only SIGKILL.
for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => { cleanup(); process.exit(1); });
}

// --- an external ping: pure loop delay, the perfbudget measurement -----------
const loop: number[] = [];
let stop = false;
async function pingLoop() {
  while (!stop) {
    const a = performance.now();
    // Timed out, not left to hang: under a saturated server this ping can stall
    // for seconds, and an uncapped one would never return — so a `stop` set
    // during it would never be seen and teardown would wait on it forever. The
    // elapsed time is recorded even when it aborts, because a ping that took
    // that long IS loop delay, which is the thing being measured.
    try { await fetch(`${S}/__perfping__`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }); } catch { /* aborted or between requests */ }
    loop.push(performance.now() - a);
    await Bun.sleep(20);
  }
}

// --- the PTY: keystroke → echo latency, the number that IS the bug -----------
const echo: number[] = [];
let ptyTimeouts = 0;
/** Milliseconds since the measure window opened — set once load starts, so a
 *  slow echo can be dated relative to it (warm-up vs. under-load). */
let measureStart = 0;
const TRACE = process.env.AGX_LOAD_TRACE === "1";
/** Resolves once the shell is primed and steady — the main flow waits on this
 *  before it clears warm-up samples and opens the measure window. */
let primedResolve: () => void;
const primed = new Promise<void>((r) => { primedResolve = r; });
/** The live PTY socket, hoisted so teardown can close it directly — a shell
 *  that floods output keeps the message handler firing, which can starve the
 *  timers the probe loop relies on to notice `stop`. Closing it ends both. */
let ptyWs: WebSocket | null = null;
async function ptyProbe(): Promise<void> {
  const ws = new WebSocket(`${WS}/terminal/pty?root=${R}&cols=80&rows=24`);
  ptyWs = ws;
  ws.binaryType = "arraybuffer";
  let pending: ((ms: number) => void) | null = null;
  let sentAt = 0;
  ws.addEventListener("message", (ev) => {
    // Output frames are binary (bytes off the pty); control frames are JSON
    // text. A keystroke's echo is the next binary frame after we sent it.
    if (pending && typeof ev.data !== "string") {
      const r = pending; pending = null;
      r(performance.now() - sentAt);
    }
  });
  // Wait for the shell, then drain its prompt/greeting so the first real
  // keystroke isn't timed against a still-rendering banner.
  await new Promise<void>((r) => { ws.addEventListener("open", () => r()); setTimeout(r, 4000); });
  await Bun.sleep(1500);

  // Prime the shell: the first keystroke into a shell launched with a fresh
  // config home pays that shell's one-time init, which a real user paid long
  // ago. Send a handful and wait out their echoes so that cost lands here, in
  // warm-up, not as a phantom spike in the measured percentiles. Discarded.
  const primeOne = (d: string) => new Promise<void>((resolve) => {
    pending = () => resolve();
    sentAt = performance.now();
    try { ws.send(JSON.stringify({ t: "in", d })); } catch { resolve(); }
    setTimeout(() => { if (pending) { pending = null; resolve(); } }, 4000);
  });
  for (let i = 0; i < 6; i++) { await primeOne("x"); await Bun.sleep(60); }
  await primeOne("\x15"); // clear the primed line
  primedResolve();

  let n = 0;
  while (!stop) {
    // Cooked-mode shells echo each printed char immediately — that echo IS what
    // "I can see what I typed" costs. A plain letter accumulates a command line,
    // so Ctrl-U clears it every so often (and its own echo isn't timed).
    if (++n % 30 === 0) { try { ws.send(JSON.stringify({ t: "in", d: "\x15" })); } catch { /* closed */ } await Bun.sleep(KEYSTROKE_MS); continue; }
    const ms = await new Promise<number>((resolve) => {
      pending = resolve;
      sentAt = performance.now();
      try { ws.send(JSON.stringify({ t: "in", d: "x" })); } catch { pending = null; resolve(-1); }
      // A key that never comes back inside 5s is a frozen terminal, not a slow
      // one — record it at the ceiling so it lands in the tail rather than
      // vanishing from the sample.
      setTimeout(() => { if (pending === resolve) { pending = null; ptyTimeouts++; resolve(5000); } }, 5000);
    });
    if (ms >= 0) {
      echo.push(ms);
      if (TRACE && ms > 500) {
        const at = measureStart ? ((performance.now() - measureStart) / 1000).toFixed(1) : "pre";
        process.stderr.write(`   [trace] slow echo ${ms.toFixed(0)}ms at t+${at}s (keystroke #${n})\n`);
      }
    }
    await Bun.sleep(KEYSTROKE_MS);
  }
  try { ws.close(); } catch { /* already closed */ }
}

// --- server CPU, from /proc, over the measure window -------------------------
const CLK = 100; // sysconf(_SC_CLK_TCK) is 100 on Linux
function cpuTicks(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the (comm) paren: utime is 14th, stime 15th (1-indexed from pid).
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[11]) + Number(after[12]); // utime + stime
  } catch { return 0; }
}
function rssMb(pid: number): number {
  try {
    const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    return kb / 1024;
  } catch { return 0; }
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((q / 100) * a.length))] ?? 0;
};
const fmt = (xs: number[]) =>
  `p50 ${pct(xs, 50).toFixed(1)}ms · p95 ${pct(xs, 95).toFixed(1)}ms · p99 ${pct(xs, 99).toFixed(1)}ms · max ${(Math.max(0, ...xs)).toFixed(0)}ms  (${xs.length} samples)`;

const chk = (m: string) => { if (TRACE) process.stderr.write(`[chk] ${m}\n`); };
let failed = false;
try {
  // Wait for boot (a cold 186MB DB may build the covering indexes first).
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${S}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await Bun.sleep(250);
  }
  if (!up) throw new Error("server never answered /health — see stderr above");

  const gets = buildGets(R);
  console.log(`loadtest: ${CLIENTS} clients · ${gets.length + (withStatusEndpoint() ? 1 : 0)} endpoints/burst · ${WORKTREES}-worktree repo`);
  console.log(`          DB: ${dbNote}`);
  console.log(`          repo: ${repo}`);
  console.log(`          load in a child process · measuring ${(MEASURE_MS / 1000).toFixed(0)}s · PTY p99 budget ${PTY_P99_BUDGET_MS}ms\n`);

  // Reset the server's stall log so we measure this run, not the boot backfill.
  const since = (await fetch(`${S}/api/loopwatch`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }).then((r) => r.json()).catch(() => ({ stalls: [] }))) as { stalls: { id: number }[] };
  const sinceId = since.stalls.at(-1)?.id ?? 0;

  chk("starting ping + pty");
  const ping = pingLoop();
  const pty = ptyProbe();
  // Wait until the shell is primed (first-run init paid) before measuring, so a
  // one-time warm-up cost never lands in the percentiles as a phantom freeze.
  await Promise.race([primed, Bun.sleep(15_000)]);
  chk("primed");
  await Bun.sleep(500);

  // Clear warm-up noise, then start the load — in its own process, so its dozens
  // of concurrent fetches never compete with the timers this loop uses to probe.
  loop.length = 0; echo.length = 0;
  const pid = server.pid!;
  const cpu0 = cpuTicks(pid);
  const t0 = performance.now();
  measureStart = t0;
  chk("load child starting");
  loadChild = spawn({
    cmd: ["bun", join(ROOT, "scripts", "loadtest.ts")],
    env: { ...process.env, AGX_LOAD_WORKER: S, AGX_LOAD_REPO: repo, AGX_LOAD_WORKER_MS: String(MEASURE_MS) },
    stdout: "ignore",
    stderr: "inherit",
  });

  await Bun.sleep(MEASURE_MS);
  chk("measure window done");

  const wall = (performance.now() - t0) / 1000;
  const cpuPct = ((cpuTicks(pid) - cpu0) / CLK / wall) * 100;
  const rss = rssMb(pid);
  stop = true;
  try { loadChild.kill(); } catch { /* already exited */ }
  // Close the PTY before waiting on the probes: a shell flooding output starves
  // the timers those loops use to see `stop`, so ending the stream is what lets
  // them finish. Hard-capped regardless — measurement is done, and a probe that
  // won't wind down must not hold the whole run open.
  try { ptyWs?.close(); } catch { /* already closed */ }
  await Promise.race([Promise.all([ping, pty]), Bun.sleep(10_000)]);
  chk("ping+pty stopped");

  // The server's own stall log for this window: worst offenders by name.
  const lw = (await fetch(`${S}/api/loopwatch?since=${sinceId}`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) }).then((r) => r.json()).catch(() => null)) as
    | { stalls: { ms: number; what: string }[]; worstMs: number; totalMs: number; spawns: { peakInflight: number; peakWaiting: number; limit: number } }
    | null;

  console.log(`— PTY echo (the stutter) —\n  ${fmt(echo)}${ptyTimeouts ? `  · ${ptyTimeouts} froze >5s` : ""}`);
  console.log(`\n— event loop, external ping —\n  ${fmt(loop)}`);
  console.log(`\n— server —\n  CPU ${cpuPct.toFixed(0)}% over ${wall.toFixed(1)}s · RSS ${rss.toFixed(0)}MB`);
  if (lw) {
    const byWhat = new Map<string, { n: number; total: number; worst: number }>();
    for (const s of lw.stalls) {
      const e = byWhat.get(s.what) ?? { n: 0, total: 0, worst: 0 };
      e.n++; e.total += s.ms; e.worst = Math.max(e.worst, s.ms);
      byWhat.set(s.what, e);
    }
    const top = [...byWhat].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
    console.log(`\n— loop stalls (server's own watchdog, this window) —`);
    console.log(`  ${lw.stalls.length} stalls · worst ${lw.worstMs}ms · spawn pool peak inflight ${lw.spawns.peakInflight}/${lw.spawns.limit}, waiting ${lw.spawns.peakWaiting}`);
    if (top.length) {
      console.log(`  who blocked the loop (by total ms):`);
      for (const [what, e] of top) console.log(`    ${e.total.toString().padStart(6)}ms  ${String(e.n).padStart(3)}×  worst ${e.worst}ms   ${what}`);
    }
  }

  const p99 = pct(echo, 99);
  console.log("");
  if (echo.length < 20) {
    console.log(`✗ loadtest: only ${echo.length} PTY samples — the probe never got going, nothing was proved`);
    failed = true;
  } else if (ptyTimeouts > 0) {
    console.log(`✗ loadtest: the terminal FROZE (>5s with no echo) ${ptyTimeouts}× under load — this is the bug`);
    failed = true;
  } else if (p99 > PTY_P99_BUDGET_MS) {
    console.log(`✗ loadtest: PTY p99 echo ${p99.toFixed(0)}ms is over the ${PTY_P99_BUDGET_MS}ms budget — the terminal stutters under load`);
    console.log(`  The stall table above names what held the loop. That is the thing to fix.`);
    failed = true;
  } else {
    console.log(`✓ loadtest: the terminal stays responsive under load (PTY p99 ${p99.toFixed(0)}ms, budget ${PTY_P99_BUDGET_MS}ms)`);
  }
} catch (e) {
  console.error(`loadtest: ${e instanceof Error ? e.message : e}`);
  failed = true;
} finally {
  stop = true;
  cleanup();
}

process.exit(failed ? 1 : 0);
