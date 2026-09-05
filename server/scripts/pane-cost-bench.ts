#!/usr/bin/env bun
/*
 * What one open pane costs the sweep, against a real tmux.
 *
 * The 23%-at-33-panes figure in the perf audit was measured at a pane count
 * nobody wrote down, so nothing could tell "thirty-three panes" from "a
 * regression" the next time somebody saw it. This puts a number under it:
 * `readFrameCached` — the call every open Terminal session's 500ms sweep
 * makes (see terminal.ts) — against a socket whose window count is grown
 * step by step, timing many calls at each step to get past spawn jitter.
 *
 * `readFrameCached` already collapsed the spawn itself to one per SOCKET per
 * tick, however many clients are attached (see the frame-cache commit and
 * its test, tmux-frame-cache.test.ts) — so this is not re-proving that fix.
 * What it still pays for, on every call, cached spawn or not, is `parseFrame`
 * walking every `w\t`/`p\t` line tmux hands back — that cost is per CALL, and
 * every attached session calls in on its own tick even when the spawn behind
 * it is shared. This measures THAT: fixed cost (spawn + parse of an empty
 * frame) plus a per-window slope, fitted by least squares over several N.
 *
 *     cd server && bun run scripts/pane-cost-bench.ts
 *
 * Read-only against its own throwaway socket. Kills it and its tmp dir when
 * done; touches nothing else.
 */
import { mkdirSync, rmSync } from "node:fs";
import { readFrameCached, type TmuxClient } from "../src/tmuxctl.ts";

const SOCK = "agx-pane-cost-bench";
const TMPDIR = `/tmp/agx-pane-cost-bench-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const TEST_TERM = "xterm-256color";

if (!Bun.which("tmux") || !Bun.which("python3") || process.platform !== "linux") {
  console.error("needs tmux + python3 on linux — skipping");
  process.exit(0);
}

const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

mkdirSync(TMPDIR, { recursive: true });
process.env.TMUX_TMPDIR = TMPDIR;
raw(["kill-server"]);
raw(["new-session", "-d", "-s", "bench", "-n", "w0", "-x", "80", "-y", "24"]);

// One real attached client so parseFrame has something to resolve `session`
// and `id` against — without it every call bails before touching the window
// or pane rows at all, which would measure nothing.
const pty = Bun.spawn(
  ["python3", "-c",
    "import os,pty,sys,time\n" +
    "pid,fd=pty.fork()\n" +
    "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
    "time.sleep(600)\n",
    SOCK, "bench"],
  { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } },
);
await Bun.sleep(1200);
const tty = out(["list-clients", "-F", "#{client_tty}"]).split("\n")[0] ?? "";
const client = (): TmuxClient => ({ pid: 0, socket: ["-f", "/dev/null", "-L", SOCK], tty });

const N_VALUES = [1, 5, 10, 20, 33, 50, 80];
const CALLS_PER_N = 60;
const points: { n: number; msPerCall: number }[] = [];

let windows = 1;
for (const n of N_VALUES) {
  while (windows < n) { raw(["new-window", "-t", "bench", "-d"]); windows++; }
  // A pane also carries an nvim-vs-shell distinction the panel reads
  // (`pane_current_command`), which is on the same list-panes line — so a
  // plain new-window pane is representative of the field cost.
  const panes = Number(out(["list-panes", "-a"]).split("\n").filter(Boolean).length);

  // Cold call first — TTL 0 always spawns — to warm the OS/exec caches the
  // same way the first tick after an app launch would, then discard it.
  readFrameCached(client(), 0);

  const start = performance.now();
  for (let i = 0; i < CALLS_PER_N; i++) readFrameCached(client(), 0); // ttl 0: never reuse, every call pays the real cost
  const ms = (performance.now() - start) / CALLS_PER_N;
  points.push({ n: panes, msPerCall: ms });
  console.log(`panes=${String(panes).padStart(3)}  avg=${ms.toFixed(3)}ms/call`);
}

// Least-squares fit: ms = fixed + perPane * panes.
const xs = points.map((p) => p.n), ys = points.map((p) => p.msPerCall);
const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
let num = 0, den = 0;
for (let i = 0; i < xs.length; i++) { num += (xs[i]! - meanX) * (ys[i]! - meanY); den += (xs[i]! - meanX) ** 2; }
const perPane = num / den;
const fixed = meanY - perPane * meanX;

console.log(`\nfit: ${fixed.toFixed(3)}ms fixed + ${perPane.toFixed(4)}ms/pane`);
console.log(`at 33 panes: ${(fixed + perPane * 33).toFixed(3)}ms per call, called once per attached session per 500ms tick`);

pty.kill();
raw(["kill-server"]);
if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = REAL_TMPDIR;
try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
