/*
 * "Keep working while an agent runs", on a Mac.
 *
 * On Linux the shell's power modes hold two things: the display (Electron's
 * blocker) and the system (a logind inhibitor). A Mac has no logind, and
 * `prevent-display-sleep` alone leaves App Nap free to throttle a backgrounded
 * window — its timers, its poll, and the sidecar it is the parent of. power.js
 * now holds `prevent-app-suspension` alongside the display blocker on darwin,
 * and releases both together. Linux keeps exactly the one blocker it had.
 *
 * Driven for real in a child process with a stubbed `electron` whose
 * powerSaveBlocker records what was started and stopped. The platform is
 * stated through `init`, because this machine is not a Mac. PATH is empty so
 * the Linux half's `systemd-inhibit` is ENOENT rather than a real lock on the
 * developer's box.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POWER = new URL("../../electron/power.js", import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } } });

type Trace = { started: string[]; stopped: string[]; status: { mode: string; awake: boolean } };

/**
 * Load power.js in a child process, drive it through `script`, and read back
 * the blocker calls it made.
 *
 * The file is copied into a scratch directory that has a `node_modules/electron`
 * of its own — the recording stub — so `require("electron")` resolves there by
 * the ordinary rule, under bun as under node. power.js reaches for nothing
 * else in its directory, so the copy behaves as the original does.
 */
async function drive(platform: string, script: string): Promise<Trace> {
  const scratch = join(tmpdir(), `agx-power-${process.pid}-${dirs.length}`);
  dirs.push(scratch);
  mkdirSync(join(scratch, "cfg"), { recursive: true });
  mkdirSync(join(scratch, "emptybin"), { recursive: true });
  mkdirSync(join(scratch, "node_modules", "electron"), { recursive: true });
  copyFileSync(POWER, join(scratch, "power.js"));
  writeFileSync(join(scratch, "node_modules", "electron", "index.js"), `
    const calls = { started: [], stopped: [] };
    const types = new Map();
    let next = 1;
    module.exports = {
      __calls: calls,
      powerMonitor: { on() {} },
      powerSaveBlocker: {
        start(type) { const id = next++; types.set(id, type); calls.started.push(type); return id; },
        isStarted(id) { return types.has(id); },
        stop(id) { calls.stopped.push(types.get(id)); types.delete(id); },
      },
    };
  `);
  writeFileSync(join(scratch, "drive.cjs"), `
    const power = require("./power.js");
    const { __calls: calls } = require("electron");
    // The two values this run needs arrive through the environment, not by
    // being spliced into the source: a path written into code is code.
    power.init({ configDir: process.env.AGX_TEST_CFG, apiOrigin: () => "http://127.0.0.1:1", token: () => "t", platform: process.env.AGX_TEST_PLATFORM });
    ${script}
    const status = power.status();
    power.shutdown();
    console.log("TRACE " + JSON.stringify({ ...calls, status }));
    process.exit(0);
  `);
  const p = Bun.spawn([process.execPath, join(scratch, "drive.cjs")], {
    cwd: scratch,
    env: { PATH: join(scratch, "emptybin"), HOME: scratch, AGX_TEST_CFG: join(scratch, "cfg"), AGX_TEST_PLATFORM: platform },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const m = /^TRACE (.*)$/m.exec(out);
  if (!m) throw new Error(`power.js gave no trace (exit ${code})\n${out}${err}`);
  return JSON.parse(m[1]!);
}

describe("power.js on a Mac", () => {
  test("`on` holds the display AND the app-suspension blocker", async () => {
    const t = await drive("darwin", `power.setMode("on");`);
    expect(t.started.sort()).toEqual(["prevent-app-suspension", "prevent-display-sleep"]);
    expect(t.status.awake).toBe(true);
    // shutdown() released both — not just the one Linux has.
    expect(t.stopped.sort()).toEqual(["prevent-app-suspension", "prevent-display-sleep"]);
  });

  test("`off` after `on` releases both, and a second `on` does not double-hold", async () => {
    const t = await drive("darwin", `power.setMode("on"); power.setMode("off"); power.setMode("on");`);
    expect(t.started).toHaveLength(4); // two per assertion, twice
    expect(t.stopped).toHaveLength(4); // released by the off, then by shutdown
    expect(t.status.awake).toBe(true);
  });

  test("`agent` with nothing working holds nothing", async () => {
    // The poll cannot reach a server (port 1); lastKnownWorking stays false.
    const t = await drive("darwin", `power.setMode("agent");`);
    expect(t.started).toEqual([]);
    expect(t.status.awake).toBe(false);
  });
});

describe("power.js on Linux is unchanged", () => {
  test("`on` holds the display blocker only — the system half is systemd's", async () => {
    const t = await drive("linux", `power.setMode("on");`);
    expect(t.started).toEqual(["prevent-display-sleep"]);
    expect(t.stopped).toEqual(["prevent-display-sleep"]);
  });
});
