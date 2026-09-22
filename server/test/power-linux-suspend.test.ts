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
 *   sleep              BLOCK-WEAK — enforced against logind's own idle action
 *                                   and not against the user who holds it, so
 *                                   the menu's suspend goes through and the
 *                                   machine still does not doze off. BLOCK on
 *                                   a logind too old for it (before 257), which
 *                                   refuses the mode at once: there, block IS
 *                                   weak — honoured for everyone but the user
 *                                   who holds it — and delay holds nothing.
 *   handle-lid-switch  BLOCK      — closing the lid on a running agent must not
 *                                   end the run; logind offers no weak or delay
 *                                   mode for a lid switch.
 *
 * And the moment logind says it is going down, the sleep lock is let go at
 * once.
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

/** Turn the stub's log into calls, with how each ended. */
function parseCalls(text: string): Call[] {
  const calls: Call[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("CALL ")) calls.push({ args: line.slice(5).split(" ") });
    else if (line.startsWith("TERM ")) { const c = calls.find((x) => x.args.join(" ") === line.slice(5) && !x.ended); if (c) c.ended = "TERM"; }
    else if (line.startsWith("REFUSED ")) { const c = calls.find((x) => x.args.join(" ") === line.slice(8) && !x.ended); if (c) c.ended = "REFUSED"; }
  }
  return calls;
}

/** `mid` is the log as the script saw it BEFORE shutdown, when it printed
 *  MID — the only snapshot that can tell a lock released by the code from one
 *  released by `shutdown()` at the end of every run. */
async function drive(script: string, env: Record<string, string> = {}): Promise<{ calls: Call[]; mid: Call[]; status: { awake: boolean } }> {
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
# A logind too old for block-weak refuses the mode at once, exit 1 (the real
# wording, measured on systemd 261 with a mode it did not know).
case "$*" in *--mode=block-weak*) if [ -n "$AGX_STUB_NO_WEAK" ]; then printf 'REFUSED %s\\n' "$*" >> "${log}"; echo "Failed to inhibit: Invalid mode specification block-weak" >&2; exit 1; fi;; esac
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
      let mid = "";
      try { mid = require("node:fs").readFileSync(process.env.AGX_LOG, "utf8"); } catch {}
      power.shutdown();
      await new Promise((r) => setTimeout(r, 300));
      console.log("TRACE " + JSON.stringify({ status, mid }));
      process.exit(0);
    })();
  `);
  const p = Bun.spawn([process.execPath, join(scratch, "drive.cjs")], {
    cwd: scratch,
    env: { PATH: `${join(scratch, "bin")}:/usr/bin:/bin`, HOME: scratch, AGX_TEST_CFG: join(scratch, "cfg"), AGX_LOG: log, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const m = /^TRACE (.*)$/m.exec(out);
  if (!m) throw new Error(`power.js gave no trace (exit ${code})\n${out}${err}`);
  let text = "";
  try { text = readFileSync(log, "utf8"); } catch { /* never called */ }
  const trace = JSON.parse(m[1]!) as { status: { awake: boolean }; mid: string };
  return { calls: parseCalls(text), mid: parseCalls(trace.mid), status: trace.status };
}

const modeOf = (c: Call) => c.args.find((a) => a.startsWith("--mode="))?.slice(7);
const whatOf = (c: Call) => c.args.find((a) => a.startsWith("--what="))?.slice(7);

describe("the Linux inhibitor", () => {
  test("holds sleep in block-weak mode and only the lid switch in block mode", async () => {
    const t = await drive(`power.setMode("on"); await new Promise((r) => setTimeout(r, 300));`);
    expect(t.status.awake).toBe(true);
    const byWhat = new Map(t.calls.map((c) => [whatOf(c), modeOf(c)]));
    expect(byWhat.get("sleep"), "a suspend the person asks for must go through; logind's own idle action must not").toBe("block-weak");
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
    `);
    /* Read BEFORE shutdown, which ends every lock: after the suspend signal
       the sleep lock is gone and the lid lock is still held. On resume
       `assertAwake` runs again. */
    const sleepLock = t.mid.find((c) => whatOf(c) === "sleep");
    const lidLock = t.mid.find((c) => whatOf(c) === "handle-lid-switch");
    expect(sleepLock?.ended, "the sleep lock was released by the suspend handler").toBe("TERM");
    expect(lidLock?.ended, "the lid lock was not").toBeUndefined();
  });

  test("falls back to a block lock on a logind that refuses block-weak — which is weak there — never to delay", async () => {
    /* Before 257 a block lock was honoured only for other, unprivileged users
       — not for the one holding it — which is exactly what block-weak spells
       out on 257 and later. A delay lock, the first fallback, holds a suspend
       for InhibitDelayMaxSec and then lets it go: nothing. */
    const t = await drive(`power.setMode("on"); await new Promise((r) => setTimeout(r, 500));`, { AGX_STUB_NO_WEAK: "1" });
    const sleepModes = t.calls.filter((c) => whatOf(c) === "sleep").map((c) => `${modeOf(c)}:${c.ended ?? "held"}`);
    expect(sleepModes).toEqual(["block-weak:REFUSED", "block:TERM"]);
    expect(t.calls.filter((c) => whatOf(c) === "handle-lid-switch")).toHaveLength(1);
  });

  test("a logind that refused block-weak is not asked again after a resume", async () => {
    /* The resume handler re-asserts every lock. A refusal is the logind's
       version speaking, and it does not change while the app runs. */
    const t = await drive(`
      power.setMode("on"); await new Promise((r) => setTimeout(r, 500));
      electron.__emit("suspend"); await new Promise((r) => setTimeout(r, 200));
      electron.__emit("resume"); await new Promise((r) => setTimeout(r, 500));
    `, { AGX_STUB_NO_WEAK: "1" });
    const sleepModes = t.calls.filter((c) => whatOf(c) === "sleep").map((c) => modeOf(c));
    expect(sleepModes).toEqual(["block-weak", "block", "block"]);
  });

  test("`off` holds nothing", async () => {
    const t = await drive(`power.setMode("off"); await new Promise((r) => setTimeout(r, 200));`);
    expect(t.calls).toEqual([]);
    expect(t.status.awake).toBe(false);
  });
});
