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

/** Wait, inside the shell, for the reopened instance to exist — same reason as
 *  `visible` below, on the other side of the process boundary. */
const AWAIT_MAIN = 'for _ in $(seq 200); do [ -n "$(main_pids)" ] && break; sleep 0.025; done';
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

/**
 * Wait until the script can see every process we just launched.
 *
 * This used to be `await Bun.sleep(200)` in front of every assertion — a guess
 * at how long six processes take to become visible in /proc. It held locally
 * and went red on a loaded CI runner, on a commit that had nothing to do with
 * it, and then passed on a re-run of the same commit: the worst shape of flake,
 * because the person reading the failure is looking at their own diff.
 *
 * Waiting for the condition instead of for a duration is both more reliable and
 * faster — on a machine where the processes are up in 10ms, this returns in
 * 10ms rather than sleeping out the other 190. The deadline exists so a genuine
 * regression fails as a clear assertion rather than as a hung test, so it
 * returns what it last saw rather than throwing.
 */
async function visible(app: string, want: number[], deadlineMs = 5000): Promise<number[]> {
  const until = Date.now() + deadlineMs;
  let seen: number[] = [];
  do {
    seen = pids((await appctl(app, "app_pids")).out);
    if (want.every((pid) => seen.includes(pid))) return seen;
    await Bun.sleep(25);
  } while (Date.now() < until);
  return seen;
}

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

    // Every one of them is ours. Asserted as "contains", not as an exact set:
    // what the script needs to be true is that nothing of this install is
    // missed, and a transient extra — a helper caught mid-fork — is genuinely
    // ours too, and genuinely fine to signal.
    const all = await visible(app, [main, ...helpers, sidecar]);
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
    await visible(app, [main]);
    expect(pids((await appctl(app, "main_pids")).out)).toEqual([main]);
    rmSync(app, { recursive: true, force: true });
  });

  test("another install's processes are left alone", async () => {
    const mine = fakeInstall();
    const theirs = fakeInstall();
    const other = launch(join(theirs, "agentglass"));
    // Wait on the *other* install, so this is not a race we win by being early:
    // the assertion below is only meaningful once `other` is genuinely visible
    // to the script, and it still must not appear under `mine`.
    await visible(theirs, [other]);
    expect((await appctl(mine, "app_pids")).out).toBe("");
    expect(alive(other)).toBe(true);
    for (const d of [mine, theirs]) rmSync(d, { recursive: true, force: true });
  });
});

describe("stopping it", () => {
  test("a healthy instance goes on the first signal, with no escalation", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"));
    await visible(app, [main]);

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
    await visible(app, [main, stubborn]);

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
    await visible(app, [orphan]);

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

describe("putting back what the install took down", () => {
  // An install has to close the running app — it is replacing the files
  // underneath it. Leaving it closed made the normal loop (merge, rebuild,
  // look at the change) end with the window gone, which reads as the rebuild
  // having broken something.
  //
  // The stub here blocks on a fifo rather than on stdin, because start_app
  // hands the app /dev/null — as it must, since the reopened app outlives the
  // shell that installed it. A stub reading stdin would see EOF and exit
  // instantly, and the test would be measuring its own harness.
  const blocker = (app: string) => {
    const fifo = join(app, "block");
    Bun.spawnSync(["mkfifo", fifo]);
    return `read x < ${fifo}`;
  };
  const ourPids = (app: string) =>
    Bun.spawnSync(["bash", "-c", `APP="${app}"; . "${APPCTL}"; app_pids`], { stdout: "pipe" })
      .stdout.toString().trim().split("\n").filter(Boolean);
  const cleanup = (app: string) => {
    for (const pid of ourPids(app)) { try { process.kill(Number(pid), 9); } catch { /* gone */ } }
    rmSync(app, { recursive: true, force: true });
  };

  test("the instance comes back with the flags it had", async () => {
    const app = fakeInstall();
    // A main process started the ordinary way for this app: with a flag.
    const main = launch(join(app, "agentglass"), blocker(app), "--ozone-platform=wayland");
    await visible(app, [main]);

    const { code, out } = await appctl(app, `stop_app && start_app && ${AWAIT_MAIN} && tr "\\0" " " < /proc/$(main_pids | head -n1)/cmdline`);
    expect(code).toBe(0);
    expect(out).toContain("reopening");
    // The same binary, and the flag it was carrying — not a bare relaunch that
    // silently drops the way this app is started.
    expect(out).toContain(`${app}/agentglass`);
    expect(out).toContain("--ozone-platform=wayland");
    cleanup(app);
  });

  test("AGENTGLASS_ scoping survives, and nothing else is carried over", async () => {
    // `make desktop-open DIR=…` scopes a window to one repo through the
    // environment. Reopening it unscoped would be a different app than the one
    // that was closed. Everything else about that environment is a dead session
    // by the time we get here, so it is deliberately left behind.
    const app = fakeInstall();
    const p = Bun.spawn([join(app, "agentglass"), "-c", blocker(app)], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, AGENTGLASS_PROJECT: "/tmp/scoped-repo", SOME_DEAD_SESSION: "nope" },
    });
    p.unref();
    spawned.push(p.pid);
    await visible(app, [p.pid]);

    const { out } = await appctl(app, `stop_app >/dev/null && start_app >/dev/null && ${AWAIT_MAIN} && tr "\\0" "\\n" < /proc/$(main_pids | head -n1)/environ`);
    expect(out).toContain("AGENTGLASS_PROJECT=/tmp/scoped-repo");
    expect(out).not.toContain("SOME_DEAD_SESSION");
    cleanup(app);
  });

  test("an install with nothing running opens nothing", async () => {
    // The person who closed it meant to. A rebuild is not a reason to reopen
    // an app that was not there.
    const app = fakeInstall();
    const { code, out } = await appctl(app, "stop_app && start_app");
    expect(code).toBe(0);
    expect(out).not.toContain("reopening");
    expect(ourPids(app)).toEqual([]);
    rmSync(app, { recursive: true, force: true });
  });
});
