#!/usr/bin/env bun
/**
 * Every "cut the requests" fix in the idle-CPU hunt moved the request count
 * and left CPU roughly where it was — 30% fewer requests, one point of CPU.
 * That is the tell that the cost is not network, it is work happening inside
 * the page. This script answers where.
 *
 * An empty backend (no repos, no panes, no live stream) idles the renderer
 * at ~0% — nothing is driving a re-render, so there is nothing to profile.
 * The demo build (`vite build --mode` with VITE_DEMO=1) is the closest thing
 * to the operator's real session without touching it: `lib/demo.ts` fabricates
 * a live event stream "a page at a time, because the live stream asks for
 * these on a timer" — the same shape of ongoing activity a real desktop
 * session has, entirely client-side, no server needed. Served with
 * `serveDist` from cdp.ts so the demo build's `/agentglass/demo/` base path
 * resolves (see eyes.ts's note: served from `/` its scripts 404 and the app
 * never mounts).
 *
 *   bun scripts/profile-idle.ts                  # 30s idle profile of demo
 *   bun scripts/profile-idle.ts --seconds 10 --top 30
 *
 * The demo build is a stand-in, and every fix reasoned about from it so far
 * moved a number without explaining one — the shell it runs in (software
 * compositing, the desktop window, the webview) is invisible from outside.
 * `--attach <port>` skips headless Chrome and the build entirely and profiles
 * whatever is already listening on that CDP port instead — the real desktop
 * app, launched with `AGENTGLASS_DEBUG_PORT=<port>` set (see electron/main.js;
 * off unless that variable is set, on purpose):
 *
 *   AGENTGLASS_DEBUG_PORT=9901 <path-to-agentglass-binary> &
 *   bun scripts/profile-idle.ts --attach 9901 --seconds 20
 */

import { spawn } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until, serveDist, DEMO_BASE } from "./cdp.ts";

const ROOT = resolve(import.meta.dir, "..");

let seconds = 30;
let top = 25;
let build = true;
let out = join(ROOT, ".agx-profile.cpuprofile");
let attachPort = 0;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--seconds") seconds = Number(argv[++i]);
  else if (a === "--top") top = Number(argv[++i]);
  else if (a === "--out") out = resolve(argv[++i] ?? out);
  else if (a === "--no-build") build = false;
  else if (a === "--attach") attachPort = Number(argv[++i]);
  else { console.error(`profile-idle: unknown flag ${a}`); process.exit(2); }
}

/** Profile whatever is already listening on `port` — the real desktop app's
 *  CDP port, started elsewhere. No build, no headless Chrome to spawn: the
 *  page under profile is somebody else's process, not one this script owns
 *  the lifecycle of. */
async function attach(port: number) {
  const cdp = await connect(port);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  console.log(`profiling ${seconds}s idle on 127.0.0.1:${port} …`);
  await Bun.sleep(seconds * 1000);
  const { profile: prof } = await cdp.send("Profiler.stop");
  cdp.close();
  writeFileSync(out, JSON.stringify(prof));
  console.log(`profile written: ${out}`);
  report(prof, top);
}

async function main() {
  if (attachPort) return attach(attachPort);
  if (build) {
    console.log("building web/dist (demo) …");
    const b = spawn({
      cmd: ["bun", "run", "build:demo"], cwd: join(ROOT, "web"),
      stdout: "inherit", stderr: "inherit",
    });
    if ((await b.exited) !== 0) { console.error("profile-idle: web build failed"); process.exit(1); }
  }

  const profileDir = mkdtempSync(join(tmpdir(), "agx-profile-chrome-"));
  const dport = 9900 + Math.floor(Math.random() * 200);
  const httpServer = serveDist(join(ROOT, "web", "dist"));
  const port = httpServer.port;

  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    chrome = spawn({
      cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profileDir}`,
        "--window-size=1440,900", "--force-device-scale-factor=2", "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
        "--force-color-profile=srgb",
        `http://127.0.0.1:${port}${DEMO_BASE}/`],
      stdout: "ignore", stderr: "ignore",
    });

    const cdp = await connect(dport);
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount", 25_000);
    await Bun.sleep(2000); // let demo seeding + first live-stream tick settle before the idle window

    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); // microseconds
    await cdp.send("Profiler.start");
    console.log(`profiling ${seconds}s idle …`);
    await Bun.sleep(seconds * 1000);
    const { profile: prof } = await cdp.send("Profiler.stop");
    cdp.close();

    writeFileSync(out, JSON.stringify(prof));
    console.log(`profile written: ${out}`);
    report(prof, top);
  } finally {
    try { chrome?.kill(); } catch { /* already gone */ }
    try { httpServer.stop(true); } catch { /* already gone */ }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

/** Self time per node, aggregated by function name + url — a `.cpuprofile`'s
 *  `samples` array is node ids, and `timeDeltas[i]` is how long that sample
 *  ran before the next one, so summing deltas per node id is the node's
 *  self time without needing a full flame-graph reconstruction. */
function report(prof: any, top: number) {
  const nodes = new Map<number, any>();
  for (const n of prof.nodes) nodes.set(n.id, n);
  const selfTime = new Map<number, number>();
  const samples: number[] = prof.samples ?? [];
  const deltas: number[] = prof.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] ?? 0;
    selfTime.set(samples[i]!, (selfTime.get(samples[i]!) ?? 0) + dt);
  }
  const totalUs = deltas.reduce((a, b) => a + b, 0);
  const rows = [...selfTime.entries()]
    .map(([id, us]) => {
      const n = nodes.get(id);
      const cf = n?.callFrame ?? {};
      const name = cf.functionName || "(anonymous)";
      const url = (cf.url || "").replace(/^.*\/web\/dist\//, "");
      return { name, url, line: cf.lineNumber, us };
    })
    .sort((a, b) => b.us - a.us)
    .slice(0, top);

  console.log(`\ntotal sampled: ${(totalUs / 1000).toFixed(0)}ms\n`);
  console.log("self%   self-ms  function                                  location");
  for (const r of rows) {
    const pct = totalUs ? ((r.us / totalUs) * 100).toFixed(1) : "0.0";
    console.log(
      `${pct.padStart(5)}%  ${(r.us / 1000).toFixed(1).padStart(7)}  ${r.name.padEnd(40).slice(0, 40)}  ${r.url}:${r.line}`
    );
  }
}

await main();
