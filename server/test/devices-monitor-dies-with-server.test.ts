/*
 * The device monitors must not outlive the server that started them.
 *
 * Measured after a restart of the installed app: `pgrep -c -x udisksctl` was 4,
 * not 1. Three of them carried an isolated run's `AGENTGLASS_STATE_DIR` in
 * their environment (a temp dir the runner deletes), and every `gio mount -m`
 * left behind had a deleted temp wrapper as its command. The child ledger only
 * covers the cases where the server still runs code: a SIGKILL, an OOM kill or
 * a timeout leaves the record in a state dir that goes away with the run, and
 * the next boot reaps only the state dir it uses.
 *
 * So the kernel ends them: `setpriv --pdeathsig TERM` is prefixed to both
 * monitors, and it execs in place, so the pid in the ledger does not change.
 * The stand-in here is a script that calls the real `ensureDeviceWatch` and
 * stays alive; the fakes on PATH write down the pid that has to die. No real
 * disk service is asked anything, and the fakes only answer a monitor call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LINUX = process.platform === "linux";
let root = "";
let bin = "";
/** A `setpriv` that refuses `--pdeathsig`, as busybox's applet does. */
let refuse = "";
const started: number[] = [];
const servers: Bun.Subprocess[] = [];

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};

async function gone(pid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) { if (!alive(pid)) return true; await Bun.sleep(50); }
  return !alive(pid);
}

const pidsIn = (file: string): number[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];

async function until(ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !ok()) await Bun.sleep(50);
}

/** The stand-in: the real `ensureDeviceWatch`, kept alive like a server, and
 *  a SIGTERM that exits through `process.exit` as `index.ts` does. */
function standIn(dir: string, name: string): string {
  const script = join(dir, `${name}.ts`);
  writeFileSync(script, `
    const { ensureDeviceWatch } = await import(${JSON.stringify(new URL("../src/volumes.ts", import.meta.url).pathname)});
    ensureDeviceWatch(() => {});
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  return script;
}

beforeAll(() => {
  if (!LINUX) return;
  root = mkdtempSync(join(tmpdir(), "agx-devices-orphan-"));
  bin = join(root, "bin");
  refuse = join(root, "refuse");
  mkdirSync(bin);
  mkdirSync(refuse);
  for (const name of ["udisksctl", "gio"]) {
    const fake = join(bin, name);
    // `exec`, so the pid written down is the pid the kernel has to signal.
    writeFileSync(fake, `#!/bin/sh\necho $$ >> "$FAKE_MONITOR_PIDS"\nexec sleep 600\n`);
    chmodSync(fake, 0o755);
  }
  writeFileSync(join(refuse, "setpriv"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(refuse, "setpriv"), 0o755);
});

afterAll(() => {
  // The stand-ins first: one left alive would keep retrying against `bin` and
  // the state dir deleted below.
  for (const s of servers) { try { s.kill("SIGKILL"); } catch { /* gone */ } }
  for (const pid of started) {
    let ours = false;
    try { ours = alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep\u0000600"); } catch { /* gone */ }
    if (ours) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!LINUX)("the device monitors die with the server", () => {
  test("SIGKILL, which runs nothing", async () => {
    const dir = join(root, "run");
    mkdirSync(dir);
    const pidFile = join(dir, "monitors.pids");
    const server = Bun.spawn(["bun", "run", standIn(dir, "stand-in")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AGENTGLASS_STATE_DIR: join(dir, "state"),
        FAKE_MONITOR_PIDS: pidFile,
      },
      stdout: "ignore", stderr: "pipe",
    });
    servers.push(server);
    await until(() => pidsIn(pidFile).length >= 2, 10_000);
    const pids = pidsIn(pidFile);
    started.push(...pids);
    expect(pids.length, "both monitors started: udisksctl and gio").toBe(2);
    await Bun.sleep(300);
    for (const pid of pids) expect(alive(pid)).toBe(true);

    server.kill("SIGKILL");
    await until(() => !alive(server.pid), 3000);
    for (const pid of pids) expect(await gone(pid, 3000), `monitor ${pid} survived the server`).toBe(true);
  }, 20_000);

  test("when setpriv refuses, the monitors still start and the ledger is the cover", async () => {
    const dir = join(root, "refused");
    mkdirSync(dir);
    const pidFile = join(dir, "monitors.pids");
    const server = Bun.spawn(["bun", "run", standIn(dir, "stand-in")], {
      env: {
        ...process.env,
        PATH: `${refuse}:${bin}:${process.env.PATH ?? ""}`,
        AGENTGLASS_STATE_DIR: join(dir, "state"),
        FAKE_MONITOR_PIDS: pidFile,
      },
      stdout: "ignore", stderr: "pipe",
    });
    servers.push(server);
    await until(() => pidsIn(pidFile).length >= 2, 10_000);
    const pids = pidsIn(pidFile);
    started.push(...pids);
    expect(pids.length, "both monitors started without --pdeathsig").toBe(2);

    const state = join(dir, "state");
    await until(() => readdirSync(state).some((n) => n.startsWith("children.")), 5_000);
    const ledger = readdirSync(state).find((n) => n.startsWith("children."))!;
    const recorded = JSON.parse(readFileSync(join(state, ledger), "utf8")) as { children: { pid: number; cmd: string }[] };
    expect(recorded.children.map((c) => c.cmd).join(" | ")).toContain("udisksctl monitor");
    expect(recorded.children.map((c) => c.pid).sort()).toEqual([...pids].sort());

    // Nothing in the kernel kills these: the ledger is what does.
    server.kill("SIGTERM");
    await until(() => !alive(server.pid), 3000);
    for (const pid of pids) expect(await gone(pid, 3000), `monitor ${pid} survived the server`).toBe(true);
  }, 20_000);

  test("a refused option is proved once, not on every spawn", async () => {
    const script = join(root, "proof.ts");
    writeFileSync(script, `
      const { deathTie } = await import(${JSON.stringify(new URL("../src/pdeathsig.ts", import.meta.url).pathname)});
      let calls = 0;
      Bun.spawnSync = ((..._a) => { calls++; return { exitCode: 1 }; });
      deathTie(); deathTie(); deathTie();
      console.log(String(calls));
    `);
    const child = Bun.spawn(["bun", "run", script], {
      env: { ...process.env, PATH: `${refuse}:${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "ignore",
    });
    servers.push(child);
    const out = await new Response(child.stdout).text();
    expect(out.trim(), "one proof for three calls").toBe("1");
  }, 20_000);
});
