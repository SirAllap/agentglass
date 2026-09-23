/*
 * The notification watcher must not outlive the server that started it.
 *
 * The server subscribes to desktop notifications at boot, which spawns one
 * `dbus-monitor --session`. Nothing killed it on the way out: the SIGINT/SIGTERM
 * handler hung up the shells and exited, and the monitor was reparented to init
 * and kept running. A monitor only notices its reader is gone when it next
 * writes, and a quiet desktop may not post a notification for hours — so every
 * close of the app left one behind, and a day of restarts left a dozen.
 *
 * Every exit path is driven against a real server: the two signals the handler
 * catches, and SIGKILL, which runs no handler at all and stands in for a crash.
 *
 * Once more with a `setpriv` that refuses `--pdeathsig`, the way util-linux
 * before 2.33 and busybox do: the monitor must still start, spawned bare, and
 * the exit hook alone must still take it down on a clean close. With a working
 * setpriv the kernel's signal covers the clean closes too, so without this case
 * the hook could be deleted and nothing would go red.
 *
 * The monitor is a fake on PATH that records its pid and sleeps, and the bus
 * address points at nothing. No real bus is opened and no desktop service is
 * started; the test asserts on the pid the fake itself wrote down.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

const ROOT = `/tmp/agx-dbus-orphan-${process.pid}`;
const BIN = join(ROOT, "bin");
/** Put ahead of BIN for the case that needs a setpriv without the option. */
const OLD_SETPRIV = join(ROOT, "old-setpriv");
const LINUX = process.platform === "linux";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  // A zombie still answers signal 0; it is dead for every purpose here.
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};

async function gone(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) { if (!alive(pid)) return true; await Bun.sleep(50); }
  return !alive(pid);
}

/** Spawned pids of the fake, in order. */
const pidsIn = (file: string): number[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];

let n = 0;
async function boot(extraPath = ""): Promise<{ server: ReturnType<typeof Bun.spawn>; pidFile: string }> {
  const dir = join(ROOT, `run-${++n}`);
  mkdirSync(dir, { recursive: true });
  const pidFile = join(dir, "monitor.pids");
  const port = await freePort();
  const server = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${extraPath}${BIN}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      FAKE_MONITOR_PIDS: pidFile,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: `agx-dbus-orphan-${process.pid}`,
      TMUX_TMPDIR: dir,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok && pidsIn(pidFile).length) return { server, pidFile }; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  server.kill("SIGKILL");
  throw new Error("the server or its monitor did not come up: " + (await new Response(server.stderr as ReadableStream).text()).slice(0, 400));
}

const started: number[] = [];

beforeAll(() => {
  if (!LINUX) return;
  mkdirSync(BIN, { recursive: true });
  const fake = join(BIN, "dbus-monitor");
  // `exec`, so the pid written down is the pid that has to die.
  writeFileSync(fake, `#!/bin/sh\necho $$ >> "$FAKE_MONITOR_PIDS"\nexec sleep 600\n`);
  chmodSync(fake, 0o755);
  mkdirSync(OLD_SETPRIV, { recursive: true });
  const old = join(OLD_SETPRIV, "setpriv");
  writeFileSync(old, `#!/bin/sh\necho "setpriv: unrecognized option '--pdeathsig'" >&2\nexit 1\n`);
  chmodSync(old, 0o755);
});

afterAll(() => {
  // Only what this file started, by pid — never by pattern. And only while the
  // pid is still the fake: one the test already proved dead may since have
  // been handed to somebody else's process.
  for (const pid of started) {
    let ours = false;
    try { ours = alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep\u0000600"); } catch { /* gone */ }
    if (ours) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!LINUX)("the dbus-monitor dies with the server", () => {
  for (const sig of ["SIGTERM", "SIGINT", "SIGKILL"] as const) {
    test(`${sig}`, async () => {
      const { server, pidFile } = await boot();
      const pids = pidsIn(pidFile);
      started.push(...pids);
      // One monitor however many subscribers the boot registers.
      expect(pids.length).toBe(1);
      const pid = pids[0]!;
      // Still there while the server is: a watcher killed early would pass the
      // assertion below for the wrong reason.
      await Bun.sleep(300);
      expect(alive(pid)).toBe(true);

      server.kill(sig);
      await server.exited;
      expect(await gone(pid, 3000)).toBe(true);
    }, SERVER_BOOT_MS);
  }

  test("SIGTERM with a setpriv that has no --pdeathsig", async () => {
    const { server, pidFile } = await boot(`${OLD_SETPRIV}:`);
    const pids = pidsIn(pidFile);
    started.push(...pids);
    // Started at all: a refused option must not turn the feature off.
    expect(pids.length).toBe(1);
    const pid = pids[0]!;
    await Bun.sleep(300);
    expect(alive(pid)).toBe(true);

    server.kill("SIGTERM");
    await server.exited;
    expect(await gone(pid, 3000)).toBe(true);
  }, SERVER_BOOT_MS);
});
