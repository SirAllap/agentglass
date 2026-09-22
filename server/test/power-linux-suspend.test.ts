/*
 * A person's own suspend wins over "agents are working".
 *
 * The Linux half of staying awake was one `systemd-inhibit` holding
 * `sleep:handle-lid-switch` in BLOCK mode. A block inhibitor on `sleep` does
 * exactly what it says to every suspend, the one a person asks for from the
 * menu included: `systemctl suspend` answers "Operation inhibited" and nothing
 * happens. Measured on the owner's machine — with an agent mid-turn the
 * suspend entry did nothing at all, with no word on screen about why.
 *
 * So the two halves of the assertion are held separately, each in the only
 * mode that fits it:
 *
 *   sleep              DELAY  — logind still suspends when asked, after giving
 *                               this process a moment (InhibitDelayMaxSec,
 *                               five seconds by default) to let go. Idle sleep
 *                               is what `agent` mode was ever meant to stop,
 *                               and idle sleep is not asked for by anybody.
 *   handle-lid-switch  BLOCK  — closing the lid on a running agent must not
 *                               end the run; logind offers no delay mode for
 *                               a lid switch, and a block is what was wanted.
 *
 * And the moment logind says it is going down, the sleep lock is let go at
 * once rather than making the person wait out the delay.
 *
 * Driven for real in a child process, with a stubbed `electron` and a
 * `systemd-inhibit` on PATH that writes down how it was called.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POWER = new URL("../../electron/power.js", import.meta.url).pathname;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } } });

/** One line per `systemd-inhibit` call: its arguments, then what ended it. */
interface Call { args: string[]; ended?: string }

async function drive(script: string): Promise<{ calls: Call[]; status: { awake: boolean } }> {
  const scratch = join(tmpdir(), `agx-power-linux-${process.pid}-${dirs.length}`);
  dirs.push(scratch);
  mkdirSync(join(scratch, "cfg"), { recursive: true });
  mkdirSync(join(scratch, "bin"), { recursive: true });
  mkdirSync(join(scratch, "node_modules", "electron"), { recursive: true });
  copyFileSync(POWER, join(scratch, "power.js"));
  const log = join(scratch, "inhibit.log");
  /* The stub records its argv, then waits like the real one — and says how
     it was ended, so a released lock is distinguishable from one that was
     simply still there at shutdown. */
  writeFileSync(join(scratch, "bin", "systemd-inhibit"), `#!/bin/sh
printf 'CALL %s\\n' "$*" >> "${log}"
trap 'printf "TERM %s\\n" "$*" >> "${log}"; exit 0' TERM
while :; do sleep 0.05; done
`, { mode: 0o755 });
  writeFileSync(join(scratch, "node_modules", "electron", "index.js"), `
    const handlers = {};
    module.exports = {
      __emit: (ev) => { for (const h of handlers[ev] ?? []) h(); },
      powerMonitor: { on(ev, h) { (handlers[ev] ??= []).push(h); } },
      powerSaveBlocker: { start() { return 1; }, isStarted() { return true; }, stop() {} },
    };
  `);
  writeFileSync(join(scratch, "drive.cjs"), `
    const power = require("./power.js");
    const electron = require("electron");
    power.init({ configDir: process.env.AGX_TEST_CFG, apiOrigin: () => "http://127.0.0.1:1", token: () => "t", platform: "linux" });
    (async () => {
      ${script}
      const status = power.status();
      power.shutdown();
      await new Promise((r) => setTimeout(r, 300));
      console.log("TRACE " + JSON.stringify({ status }));
      process.exit(0);
    })();
  `);
  const p = Bun.spawn([process.execPath, join(scratch, "drive.cjs")], {
    cwd: scratch,
    env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin`, HOME: scratch, AGX_TEST_CFG: join(scratch, "cfg") },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const m = /^TRACE (.*)$/m.exec(out);
  if (!m) throw new Error(`power.js gave no trace (exit ${code})\n${out}${err}`);
  const calls: Call[] = [];
  let text = "";
  try { text = readFileSync(log, "utf8"); } catch { /* never called */ }
  for (const line of text.split("\n")) {
    if (line.startsWith("CALL ")) calls.push({ args: line.slice(5).split(" ") });
    else if (line.startsWith("TERM ")) { const c = calls.find((x) => x.args.join(" ") === line.slice(5) && !x.ended); if (c) c.ended = "TERM"; }
  }
  return { calls, status: JSON.parse(m[1]!).status };
}

const modeOf = (c: Call) => c.args.find((a) => a.startsWith("--mode="))?.slice(7);
const whatOf = (c: Call) => c.args.find((a) => a.startsWith("--what="))?.slice(7);

describe("the Linux inhibitor", () => {
  test("holds sleep in delay mode and only the lid switch in block mode", async () => {
    const t = await drive(`power.setMode("on"); await new Promise((r) => setTimeout(r, 300));`);
    expect(t.status.awake).toBe(true);
    const byWhat = new Map(t.calls.map((c) => [whatOf(c), modeOf(c)]));
    expect(byWhat.get("sleep"), "a suspend the person asks for must go through").toBe("delay");
    expect(byWhat.get("handle-lid-switch"), "closing the lid must still not end a run").toBe("block");
    /* Never the two together: `sleep:handle-lid-switch` cannot be delay
       (logind refuses delay for a lid switch) and must not be block. */
    expect(t.calls.some((c) => (whatOf(c) ?? "").includes(":"))).toBe(false);
    /* And both were let go on shutdown, not left holding the machine. */
    expect(t.calls.every((c) => c.ended === "TERM")).toBe(true);
  });

  test("lets go of the sleep lock the moment logind says it is suspending", async () => {
    const t = await drive(`
      power.setMode("on"); await new Promise((r) => setTimeout(r, 300));
      electron.__emit("suspend"); await new Promise((r) => setTimeout(r, 300));
      const held = require("node:fs").readFileSync("${"inhibit.log"}", "utf8");
      console.log("MID " + JSON.stringify(held));
    `);
    /* After the suspend signal the sleep lock is gone; the lid lock may stay
       (it does not delay anything). On resume `assertAwake` runs again. */
    const sleepLock = t.calls.find((c) => whatOf(c) === "sleep");
    expect(sleepLock).toBeDefined();
    expect(sleepLock!.ended).toBe("TERM");
  });

  test("`off` holds nothing", async () => {
    const t = await drive(`power.setMode("off"); await new Promise((r) => setTimeout(r, 200));`);
    expect(t.calls).toEqual([]);
    expect(t.status.awake).toBe(false);
  });
});
