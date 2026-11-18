/*
 * The tab strip's sweep (and the nudge that fires it) must not hold the event
 * loop while a slow tmux answers. `reclaimPinnedWindow` asked tmux with a
 * blocking spawn from inside that sweep: one slow `show-options` was a server
 * stall of over a second ("terminal tmux nudge").
 *
 * The slow tmux is a stub script on a PATH of its own, and it lives in a CHILD
 * process: this process's PATH is never touched, because a test that leaks PATH
 * breaks every later tmux test in the run.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_MS = 800;

const CHILD = `
const ctl = await import(${JSON.stringify(join(import.meta.dir, "../src/tmuxctl.ts"))});
const socket = ["-L", "agx-stall-probe"];
// First call starts the wait; move the clock past it so the second one asks tmux.
const realNow = Date.now;
await ctl.reclaimPinnedWindow(socket, "$1", "@1", true);
Date.now = () => realNow() + 10_000;
let last = realNow(), worst = 0;
const tick = setInterval(() => { const n = realNow(); worst = Math.max(worst, n - last); last = n; }, 10);
const t0 = realNow();
await ctl.reclaimPinnedWindow(socket, "$1", "@1", true);
const took = realNow() - t0;
// A blocked loop only shows as one late tick after it frees up, so wait for it.
await new Promise((r) => setTimeout(r, 60));
clearInterval(tick);
console.log(JSON.stringify({ worst, took }));
process.exit(0);
`;

test("a slow tmux under reclaimPinnedWindow does not stop the event loop", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agx-slow-tmux-"));
  const before = process.env.PATH;
  try {
    const stub = join(dir, "tmux");
    writeFileSync(stub, `#!/bin/sh\nsleep ${STUB_MS / 1000}\n`);
    chmodSync(stub, 0o755);
    const child = Bun.spawn([process.execPath, "-e", CHILD], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    await child.exited;
    const { worst, took } = JSON.parse(out.trim().split("\n").pop()!) as { worst: number; took: number };
    // The stub really was asked, and the loop kept ticking while it slept.
    expect(took).toBeGreaterThanOrEqual(STUB_MS - 100);
    expect(worst).toBeLessThan(250);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    expect(process.env.PATH).toBe(before);
  }
}, 30_000);

test("a phone that attaches during the checks keeps its window: no resize after the recheck says held", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agx-held-tmux-"));
  try {
    const log = join(dir, "calls.log");
    const stub = join(dir, "tmux");
    // show-options answers with a mark of ours; every call is logged.
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in *show-options*) echo largest;; esac\n`);
    chmodSync(stub, 0o755);
    const code = `
      const ctl = await import(${JSON.stringify(join(import.meta.dir, "../src/tmuxctl.ts"))});
      const socket = ["-L", "agx-held-probe"];
      const realNow = Date.now;
      await ctl.reclaimPinnedWindow(socket, "$1", "@1", () => true);
      Date.now = () => realNow() + 10_000;
      let asked = 0;
      const did = await ctl.reclaimPinnedWindow(socket, "$1", "@1", () => ++asked === 1);
      console.log(JSON.stringify({ did }));
      process.exit(0);`;
    const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(JSON.parse(out.trim().split("\n").pop()!).did).toBe(false);
    const calls = await Bun.file(log).text();
    expect(calls).toContain("show-options");
    expect(calls).not.toContain("resize-window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
