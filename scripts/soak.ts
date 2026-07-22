#!/usr/bin/env bun
/**
 * Does the server grow?
 *
 * "No growing shit over time" is the hardest of the performance asks to satisfy
 * by inspection, because leaks do not show up in a request — they show up in a
 * machine that has been running the app since Monday. This app is left open all
 * day by design: a dozen shells, panels polling, a transcript scanner sweeping,
 * caches on nearly every read. Every one of those is somewhere for memory to
 * quietly accumulate.
 *
 * So it runs the app hard for a while and watches its resident set. A leak
 * shows up as a line that keeps climbing; a healthy process settles, because
 * every cache in here is bounded and the rest is garbage.
 *
 *   bun scripts/soak.ts             # ~3 minutes, enough to see a trend
 *   AGX_SOAK_MINUTES=30 bun …       # long enough to be sure
 *
 * Not wired into CI. A soak that runs on every push is a slow build; this is
 * for the question "has it been getting worse?", asked deliberately.
 */

import { spawn } from "bun";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const MINUTES = Number(process.env.AGX_SOAK_MINUTES || 3);
/** How much growth over the run is a leak rather than a warm-up. */
const GROWTH_LIMIT = 1.6;

function buildRepo(base: string): string {
  const repo = join(base, "orbit");
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "# orbit\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "first");
  for (let i = 1; i <= 6; i++) {
    const b = `WEB-${1000 + i}`;
    g(repo, "worktree", "add", "-q", "-b", b, join(base, `orbit-${b}`));
  }
  writeFileSync(join(repo, "scratch.txt"), "in progress\n");
  return repo;
}

/** Resident set of a pid, in MB. /proc rather than `ps`, so this is one read. */
function rssMb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return kb / 1024;
  } catch {
    return 0;
  }
}

const base = mkdtempSync(join(tmpdir(), "agx-soak-"));
const home = mkdtempSync(join(tmpdir(), "agx-soak-home-"));
const repo = process.env.AGX_SOAK_ROOT || buildRepo(base);
const port = 4990 + Math.floor(Math.random() * 9);
const S = `http://127.0.0.1:${port}`;
const R = encodeURIComponent(repo);

const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port), AGENTGLASS_ROOT: repo,
    AGENTGLASS_DB: join(home, "soak.db"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    AGENTGLASS_TOKEN: "", AGENTGLASS_SCAN_DISABLED: "1",
  },
  stdout: "ignore", stderr: "inherit",
});

const POLLED = [
  `/git/tree?root=${R}`, `/git/repos`, `/git/branches?root=${R}`,
  `/git/graph?root=${R}&limit=500&scope=head`, `/git/worktrees?root=${R}`,
  `/events/filter-options`, `/sessions?limit=100`, `/stats?window=3600000`,
];

let failed = false;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${S}/health`)).ok) break; } catch { /* booting */ }
    await Bun.sleep(250);
  }
  // A shell, opened and left running, because that is how the app is used and
  // because the PTY store is the most obvious place for a session to leak.
  const ws = new WebSocket(`${S.replace("http", "ws")}/terminal/pty?root=${R}&cols=80&rows=24`);
  ws.binaryType = "arraybuffer";
  await new Promise((r) => { ws.addEventListener("open", r); setTimeout(r, 3000); });

  await Bun.sleep(2000);
  const samples: { at: number; mb: number }[] = [];
  const t0 = Date.now();
  const until = t0 + MINUTES * 60_000;
  let rounds = 0;

  console.log(`soaking for ${MINUTES} min — ${POLLED.length} endpoints on a loop, one live shell\n`);
  console.log(`${"elapsed".padEnd(9)}${"rss".padStart(8)}${"rounds".padStart(9)}`);
  while (Date.now() < until) {
    await Promise.all(POLLED.map((p) => fetch(S + p).then((r) => r.text()).catch(() => "")));
    try { ws.send(JSON.stringify({ t: "in", d: "echo soak\r" })); } catch { /* closed */ }
    rounds++;
    await Bun.sleep(500);
    if (rounds % 20 === 0) {
      const mb = rssMb(server.pid!);
      samples.push({ at: Date.now() - t0, mb });
      console.log(`${((Date.now() - t0) / 1000).toFixed(0).padEnd(9)}s${mb.toFixed(0).padStart(6)}MB${String(rounds).padStart(9)}`);
    }
  }

  // Medians of the first and last thirds, not two single readings.
  //
  // A healthy process on this workload sawtooths — 98MB to 134MB and back as
  // the collector runs — so comparing one sample against another is comparing
  // where in that cycle each happened to land. Measured on a run with no leak
  // at all, that reads anywhere from ×0.8 to ×1.4 depending on luck, which is
  // a check that fails at random and then gets ignored. A median per third is
  // steady enough to mean something.
  const settled = samples.slice(1);
  const mid = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  };
  const third = Math.max(1, Math.floor(settled.length / 3));
  const first = mid(settled.slice(0, third).map((s) => s.mb));
  const last = mid(settled.slice(-third).map((s) => s.mb));
  const growth = first ? last / first : 1;
  const peak = Math.max(...settled.map((s) => s.mb), 0);
  console.log(`\n${rounds} rounds · rss ${first.toFixed(0)}MB → ${last.toFixed(0)}MB (×${growth.toFixed(2)}), peak ${peak.toFixed(0)}MB`);

  if (samples.length < 3) {
    console.log("✗ soak: too few samples to say anything — run it longer");
    failed = true;
  } else if (growth > GROWTH_LIMIT) {
    console.log(`✗ soak: resident set grew ×${growth.toFixed(2)} over ${MINUTES} min — that is a leak, not a warm-up`);
    failed = true;
  } else {
    console.log(`✓ soak: memory settled (×${growth.toFixed(2)} over ${MINUTES} min, limit ×${GROWTH_LIMIT})`);
  }
  try { ws.close(); } catch { /* already closed */ }
} finally {
  try { server.kill(); } catch { /* already gone */ }
  rmSync(home, { recursive: true, force: true });
  if (!process.env.AGX_SOAK_ROOT) rmSync(base, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
