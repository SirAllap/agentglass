// electron/install-local.sh used to stop a running install with
// `pkill -f "$APP/agentglass"`, and every Electron helper — gpu-process,
// zygote, utility, renderer — carries that same path in its own command line.
// So the whole tree got SIGTERM at once and the main process was left running
// its quit path with its children pulled out from under it: a frozen window
// that in one case was still alive 34 minutes later, holding deleted inodes,
// while the script had already copied a new build over it.
//
// These tests drive electron/appctl.sh against a fake install: a real directory
// with a real binary in it, and real processes running that binary, because the
// bug was entirely about which processes a pattern matches. Asserting on the
// script's text would have passed against the broken version too.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPCTL = join(import.meta.dir, "..", "..", "electron", "appctl.sh");
const spawned: number[] = [];

/** A fake install: our own copy of a shell, named the way the real one is. The
 *  copy matters — /proc/<pid>/exe has to point inside the install directory. */
function fakeInstall() {
  const app = mkdtempSync(join(tmpdir(), "agx-install-"));
  mkdirSync(join(app, "resources"));
  copyFileSync("/bin/sh", join(app, "agentglass"));
  copyFileSync("/bin/sh", join(app, "resources", "agentglass-server"));
  return app;
}

/** Run a process out of the fake install. `; true` keeps the shell from
 *  exec'ing the sleep away, which would replace the exe we are matching on. */
function launch(exe: string, script: string, ...args: string[]): number {
  const p = Bun.spawn([exe, "-c", `${script}; true`, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  p.unref();
  spawned.push(p.pid);
  return p.pid;
}

/** Call a function from appctl.sh with APP pointed at the fake install. */
async function appctl(app: string, call: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(["bash", "-c", `APP="${app}"; . "${APPCTL}"; ${call}`], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out: out.trim() };
}

const pids = (out: string) => out.split("\n").filter((l) => /^\d+$/.test(l)).map(Number);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, 9); } catch { /* already gone */ } }
});

describe("finding the processes that belong to an install", () => {
  test("helpers are not mistaken for the main process", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), "sleep 30");
    // The four shapes Electron actually spawns, all sharing the main's path.
    const helpers = [
      launch(join(app, "agentglass"), "sleep 30", "--type=zygote"),
      launch(join(app, "agentglass"), "sleep 30", "--type=gpu-process", "--ozone-platform=wayland"),
      launch(join(app, "agentglass"), "sleep 30", "--type=utility", "--utility-sub-type=network.mojom.NetworkService"),
      launch(join(app, "agentglass"), "sleep 30", "--type=renderer"),
    ];
    const sidecar = launch(join(app, "resources", "agentglass-server"), "sleep 30");
    await Bun.sleep(200);

    const all = pids((await appctl(app, "app_pids")).out);
    expect(all.sort()).toEqual([main, ...helpers, sidecar].sort());

    // The whole fix in one assertion: only the main process gets signalled.
    expect(pids((await appctl(app, "main_pids")).out)).toEqual([main]);
    rmSync(app, { recursive: true, force: true });
  });

  test("another install's processes are left alone", async () => {
    const mine = fakeInstall();
    const theirs = fakeInstall();
    const other = launch(join(theirs, "agentglass"), "sleep 30");
    await Bun.sleep(200);
    expect((await appctl(mine, "app_pids")).out).toBe("");
    expect(alive(other)).toBe(true);
    for (const d of [mine, theirs]) rmSync(d, { recursive: true, force: true });
  });
});

describe("stopping it", () => {
  test("a healthy instance is waited out, not raced", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), "sleep 30");
    // A helper that goes when its main goes, the way a real one does.
    const helper = launch(join(app, "agentglass"), `while kill -0 ${main} 2>/dev/null; do sleep 0.05; done`, "--type=renderer");
    const sidecar = launch(join(app, "resources", "agentglass-server"), `while kill -0 ${main} 2>/dev/null; do sleep 0.05; done`);
    await Bun.sleep(200);

    const { code } = await appctl(app, "stop_app");
    expect(code).toBe(0);
    // stop_app only returns 0 once nothing from the install is left — which is
    // the guarantee the caller needs before it starts rm -rf'ing these files.
    for (const pid of [main, helper, sidecar]) expect(alive(pid)).toBe(false);
    rmSync(app, { recursive: true, force: true });
  });

  test("something that ignores SIGTERM is escalated, not slept through", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), "sleep 30");
    const stubborn = launch(join(app, "agentglass"), "trap '' TERM; sleep 30", "--type=renderer");
    await Bun.sleep(200);

    const { code, out } = await appctl(app, "stop_app", { APPCTL_GRACE_TENTHS: "5" });
    expect(code).toBe(0);
    expect(out).toContain("still up after");
    expect(alive(stubborn)).toBe(false);
    expect(alive(main)).toBe(false);
    rmSync(app, { recursive: true, force: true });
  });

  test("a sidecar left behind by a previous wedge is cleared", async () => {
    const app = fakeInstall();
    const orphan = launch(join(app, "resources", "agentglass-server"), "trap '' TERM; sleep 30");
    await Bun.sleep(200);

    const { code, out } = await appctl(app, "stop_app", { APPCTL_GRACE_TENTHS: "5" });
    expect(code).toBe(0);
    expect(out).toContain("leftovers");
    expect(alive(orphan)).toBe(false);
    rmSync(app, { recursive: true, force: true });
  });

  test("nothing running is a no-op success", async () => {
    const app = fakeInstall();
    expect((await appctl(app, "stop_app")).code).toBe(0);
    rmSync(app, { recursive: true, force: true });
  });
});
