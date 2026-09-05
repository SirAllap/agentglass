#!/usr/bin/env bun
/*
 * Measure the benefit of caching parseFrame results per (socket, session_id).
 *
 * With TTL=0, every call to readFrameCached parses the raw output (no cache).
 * With TTL=450, only the first call parses; subsequent calls within 450ms
 * reuse the cached parse, avoiding the cost of walking all windows/panes.
 *
 * Difference: (N-1) * parseFrame cost, where N is the call count.
 */
import { mkdirSync, rmSync } from "node:fs";
import { readFrameCached, type TmuxClient } from "../src/tmuxctl.ts";

const SOCK = "agx-parse-cache-bench";
const TMPDIR = `/tmp/agx-parse-cache-bench-${process.pid}`;
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

// One real attached client
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

// Create 33 panes to match the benchmark conditions
let panes = 1;
while (panes < 33) { raw(["new-window", "-t", "bench", "-d"]); panes++; }

// Warmup
readFrameCached(client(), 0);

const CALLS = 60;

// Measure with TTL=0 (no parse cache, every call parses)
const start0 = performance.now();
for (let i = 0; i < CALLS; i++) readFrameCached(client(), 0);
const ms0 = (performance.now() - start0) / CALLS;

// Measure with TTL=450 (parse cache enabled)
const start450 = performance.now();
for (let i = 0; i < CALLS; i++) readFrameCached(client(), 450);
const ms450 = (performance.now() - start450) / CALLS;

console.log(`\n33 panes, ${CALLS} calls:`);
console.log(`TTL=0   (no parse cache): ${ms0.toFixed(3)}ms/call avg`);
console.log(`TTL=450 (parse cached):   ${ms450.toFixed(3)}ms/call avg`);
console.log(`\nParse cache benefit: ${((1 - ms450/ms0) * 100).toFixed(1)}% faster`);
console.log(`Per call saved: ${(ms0 - ms450).toFixed(3)}ms`);

// The first call with TTL=450 still pays full cost, but calls 2-60 are fast.
// So the savings is (60-1) * (ms0 - ms450) = what the cache saved us.
const savedMs = (CALLS - 1) * (ms0 - ms450);
console.log(`Total saved over ${CALLS} calls: ${savedMs.toFixed(1)}ms`);

pty.kill();
raw(["kill-server"]);
if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = REAL_TMPDIR;
try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
