/*
 * The `docker events` watcher must not outlive the server that started it.
 *
 * Measured: thirty of them found orphaned, hours old, one per test or probe
 * server that had already exited. `docker events` only notices its reader is
 * gone when it next writes, and on a quiet machine that is never.
 *
 * A stand-in `docker` on PATH writes its pid and sleeps, so this needs no
 * daemon and never skips.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-dockerleak-"));
const pidFile = join(dir, "docker.pid");
const stray: number[] = [];
afterAll(() => {
  for (const pid of stray) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await Bun.sleep(50); }
  return fn();
};

async function leaked(kill: (server: ReturnType<typeof Bun.spawn>) => void): Promise<boolean> {
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
  chmodSync(join(dir, "docker"), 0o755);
  rmSync(pidFile, { force: true });
  const script = `import { startVolumeWatch } from ${JSON.stringify(join(import.meta.dir, "../src/dockerwatch.ts"))};
    startVolumeWatch(); console.log("up"); setInterval(() => {}, 1000);`;
  const server = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe", stderr: "ignore",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NODE_ENV: "test" },
  });
  await (server.stdout as ReadableStream<Uint8Array>).getReader().read();
  expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5000)).toBe(true);
  const watcher = Number(readFileSync(pidFile, "utf8"));
  stray.push(watcher);
  expect(alive(watcher)).toBe(true);
  kill(server);
  await server.exited;
  return !(await until(() => !alive(watcher), 8000));
}

test("SIGKILL of the server takes the watcher with it", async () => {
  expect(await leaked((s) => s.kill("SIGKILL"))).toBe(false);
}, 20_000);

test("SIGTERM of the server takes the watcher with it", async () => {
  expect(await leaked((s) => s.kill("SIGTERM"))).toBe(false);
}, 20_000);
