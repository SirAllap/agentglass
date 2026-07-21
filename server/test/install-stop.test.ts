// electron/install-local.sh used to stop a running install with
// `pkill -f "$APP/agentglass"`, and every Electron helper — gpu-process,
// zygote, utility, renderer — carries that same path in its own command line.
// So the whole tree got SIGTERM at once and the main process was left running
// its quit path with its children pulled out from under it: a frozen window
// that in one case was still alive 34 minutes later, holding deleted inodes,
// while the script had already copied a new build over it.
//
// #136 fixed that by signalling only what matched `^($APP|$BIN)/agentglass$`,
// which excludes the helpers correctly and also excludes a main process started
// with a flag. This file guards the version that identifies processes by the
// binary behind them instead.
//
// These tests drive electron/appctl.sh against a fake install: a real directory
// with a real binary in it, and real processes running that binary, because the
// bug was entirely about which processes get matched. Asserting on the script's
// text would have passed against the broken version too.
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

/**
 * Run a process out of the fake install.
 *
 * The script must block in a *builtin* and fork nothing. An earlier version
 * used `sleep 30; true`, and the `; true` did stop the shell exec'ing the sleep
 * away — but it left the shell forking a child for it, and a forked child is a
 * process running this same binary until the exec lands. Under bash that window
 * is invisible; under the dash that CI's /bin/sh points at, six launches showed
 * up as twelve pids and the exact-set assertion failed. `read` blocks forever on
 * a pipe nobody writes to, in both shells, without forking anything.
 */
function launch(exe: string, script = "read x", ...args: string[]): number {
  const p = Bun.spawn([exe, "-c", script, ...args], { stdio: ["pipe", "ignore", "ignore"] });
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
    const main = launch(join(app, "agentglass"));
    // The four shapes Electron actually spawns, all sharing the main's path.
    const helpers = [
      launch(join(app, "agentglass"), "read x", "--type=zygote"),
      launch(join(app, "agentglass"), "read x", "--type=gpu-process", "--ozone-platform=wayland"),
      launch(join(app, "agentglass"), "read x", "--type=utility", "--utility-sub-type=network.mojom.NetworkService"),
      launch(join(app, "agentglass"), "read x", "--type=renderer"),
    ];
    const sidecar = launch(join(app, "resources", "agentglass-server"));
    await Bun.sleep(200);

    // Every one of them is ours. Asserted as "contains", not as an exact set:
    // what the script needs to be true is that nothing of this install is
    // missed, and a transient extra — a helper caught mid-fork — is genuinely
    // ours too, and genuinely fine to signal.
    const all = pids((await appctl(app, "app_pids")).out);
    for (const pid of [main, ...helpers, sidecar]) expect(all).toContain(pid);

    // The whole fix in one assertion: only the main process gets signalled.
    expect(pids((await appctl(app, "main_pids")).out)).toEqual([main]);
    rmSync(app, { recursive: true, force: true });
  });

  test("a main process started with a flag is still found", async () => {
    // The gap in matching by command-line shape: a pattern anchored tightly
    // enough to exclude the helpers (`^$APP/agentglass$`) also excludes this,
    // and launching with --ozone-platform=wayland or --no-sandbox is ordinary.
    // The caller then reads "nothing is running" and installs over a live app,
    // which is the failure this whole file exists to prevent.
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), "read x", "--ozone-platform=wayland");
    await Bun.sleep(200);
    expect(pids((await appctl(app, "main_pids")).out)).toEqual([main]);
    rmSync(app, { recursive: true, force: true });
  });

  test("another install's processes are left alone", async () => {
    const mine = fakeInstall();
    const theirs = fakeInstall();
    const other = launch(join(theirs, "agentglass"));
    await Bun.sleep(200);
    expect((await appctl(mine, "app_pids")).out).toBe("");
    expect(alive(other)).toBe(true);
    for (const d of [mine, theirs]) rmSync(d, { recursive: true, force: true });
  });
});

describe("stopping it", () => {
  test("a healthy instance goes on the first signal, with no escalation", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"));
    await Bun.sleep(200);

    const { code, out } = await appctl(app, "stop_app");
    expect(code).toBe(0);
    expect(alive(main)).toBe(false);
    // The bit that matters: it waited for the process to actually be gone and
    // never reached for SIGKILL. A `sleep 2` and a hope looks identical from
    // the outside right up until the app is slow, which is when it matters.
    expect(out).not.toContain("still up after");
    rmSync(app, { recursive: true, force: true });
  });

  test("something that ignores SIGTERM is escalated, not slept through", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"));
    const stubborn = launch(join(app, "agentglass"), "trap '' TERM; read x", "--type=renderer");
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
    const orphan = launch(join(app, "resources", "agentglass-server"), "trap '' TERM; read x");
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
