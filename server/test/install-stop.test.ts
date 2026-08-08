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
import { readFileSync } from "node:fs";
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

/**
 * A stub that blocks on a fifo rather than on stdin, because start_app hands
 * the app /dev/null — as it must, since the reopened app outlives the shell
 * that installed it. A stub reading stdin would see EOF and exit instantly, and
 * the test would be measuring its own harness.
 */
const blocker = (app: string) => {
  const fifo = join(app, "block");
  Bun.spawnSync(["mkfifo", fifo]);
  return `read x < ${fifo}`;
};
const ourPids = (app: string) =>
  Bun.spawnSync(["bash", "-c", `APP="${app}"; . "${APPCTL}"; app_pids`], { stdout: "pipe" })
    .stdout.toString().trim().split("\n").filter(Boolean);
const cleanupInstall = (app: string) => {
  for (const pid of ourPids(app)) { try { process.kill(Number(pid), 9); } catch { /* gone */ } }
  rmSync(app, { recursive: true, force: true });
};

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
    cleanupInstall(app);
  });

  test("AGENTGLASS_ scoping survives, and nothing else is carried over", async () => {
    // `make desktop-open DIR=…` scopes a window to one repo through the
    // environment. Reopening it unscoped would be a different app than the one
    // that was closed. Everything else about that environment is a dead session
    // by the time we get here, so it is deliberately left behind.
    //
    // Read off the SIDECAR, which inherits the app's environment and, unlike
    // the Electron main, still has one to read. The grace is shortened because
    // a fake sidecar does not die with its parent the way AGENTGLASS_DIE_WITH_-
    // PARENT makes the real one: without it stop_app waits out its full ten
    // seconds before escalating, and the test times out on its own harness.
    const app = fakeInstall();
    const p = Bun.spawn([join(app, "resources", "agentglass-server"), "-c", blocker(app)], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, AGENTGLASS_PROJECT: "/tmp/scoped-repo", SOME_DEAD_SESSION: "nope" },
    });
    p.unref();
    spawned.push(p.pid);
    const main = launch(join(app, "agentglass"), `read x < ${join(app, "block")}`);
    await visible(app, [p.pid, main]);

    const { out } = await appctl(app,
      `stop_app >/dev/null && start_app >/dev/null && ${AWAIT_MAIN} && tr "\\0" "\\n" < /proc/$(main_pids | head -n1)/environ`,
      { APPCTL_GRACE_TENTHS: "5" });
    expect(out).toContain("AGENTGLASS_PROJECT=/tmp/scoped-repo");
    expect(out).not.toContain("SOME_DEAD_SESSION");
    cleanupInstall(app);
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

  /*
   * And putting it back when the install FAILED, which is the case that was
   * missing entirely.
   *
   * install-local.sh stops the app because it is about to replace the files
   * under it. Every failure path below that point simply exited, so a failed
   * verification left the desktop with no app, no window, and no line saying
   * that was why. That happened today.
   */
  test("a failed install puts back the instance it stopped, and says so", async () => {
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), blocker(app), "--ozone-platform=wayland");
    await visible(app, [main]);

    // Exactly what the installer's EXIT trap runs: the app is already down and
    // something below the stop has failed.
    const { code, out } = await appctl(app,
      `stop_app >/dev/null; restore_after_failed_install 7 stopped 2>&1; ${AWAIT_MAIN}; main_pids`);
    expect(code).toBe(0);
    // Says what happened, with the exit code, rather than leaving a blank
    // terminal and a missing window to be interpreted.
    expect(out).toContain("The install FAILED (exit 7)");
    expect(out).toContain("Nothing was replaced");
    // And the window is back.
    expect(out).toContain("reopening");
    const back = pids(out);
    expect(back.length).toBe(1);
    expect(back[0]).not.toBe(main);
    expect(alive(main)).toBe(false);
    cleanupInstall(app);
  });

  test("it does not claim the old app survived when the copy had already run", async () => {
    // The message it replaced said "nothing was left half-written" from both
    // sides of the copy. After the copy that is false — the files on disk are
    // the new ones — and a reassuring sentence that is false is the same class
    // of bug as a stamp naming a commit the binary does not contain.
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), blocker(app));
    await visible(app, [main]);

    const { out } = await appctl(app,
      `stop_app >/dev/null; restore_after_failed_install 1 replaced 2>&1; ${AWAIT_MAIN}`);
    expect(out).toContain("did not verify");
    expect(out).not.toContain("Nothing was replaced");
    expect(out).toContain("reopening");
    cleanupInstall(app);
  });

  test("a failure with nothing running still opens nothing", async () => {
    const app = fakeInstall();
    const { code, out } = await appctl(app, "stop_app >/dev/null; restore_after_failed_install 1 stopped 2>&1");
    expect(code).toBe(0);
    expect(out).toContain("No app was running");
    expect(out).not.toContain("reopening");
    expect(ourPids(app)).toEqual([]);
    rmSync(app, { recursive: true, force: true });
  });
});

/*
 * The one link the process tests above cannot reach: that install-local.sh
 * actually arms the recovery, and arms it in the window where it is needed.
 *
 * A trap rather than a check at each exit, because `set -e` makes "exit" the
 * default outcome of anything that goes wrong down there — and it was the paths
 * nobody had thought about that stranded him, not the ones with an explicit
 * `exit 1` next to them.
 */
describe("the installer arms the recovery", () => {
  const INSTALL = readFileSync(new URL("../../electron/install-local.sh", import.meta.url), "utf8");
  const at = (needle: string) => {
    const i = INSTALL.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test("the EXIT trap is set once the app is down and before anything is replaced", () => {
    expect(at("trap ")).toBeGreaterThan(at("stop_app"));
    expect(at("trap ")).toBeLessThan(at("rm -rf \"$APP\""));
    expect(INSTALL).toContain("restore_after_failed_install");
  });

  test("how far it got is recorded on both sides of the copy", () => {
    // Without this the trap can only guess, and a guess here is a sentence that
    // tells someone their old app is fine when it has already been overwritten.
    expect(at("PHASE=replacing")).toBeLessThan(at("rm -rf \"$APP\""));
    expect(at("PHASE=replaced")).toBeGreaterThan(at("rm -rf \"$APP\""));
  });

  test("the success path cannot make it reopen twice", () => {
    // start_app at the end can itself fail, and `set -e` turns that into an
    // exit — straight into the trap, which would try the same thing again.
    // The guard has to be set on the success path too, not only inside the
    // trap, which is why this looks at the LAST occurrence of each.
    expect(INSTALL.lastIndexOf("RESTORED=1")).toBeGreaterThan(at("PHASE=replaced"));
    expect(INSTALL.lastIndexOf("RESTORED=1")).toBeLessThan(INSTALL.lastIndexOf("start_app"));
  });
});

/*
 * What the installer is allowed to carry across a restart.
 *
 * It captured every AGENTGLASS_* off the running instance and replayed it. That
 * is right for AGENTGLASS_ROOT — it is why a reopened window comes back on the
 * same project — and wrong for everything the shell derives for itself.
 *
 * The failure it produced, in full: an app launched from a terminal INSIDE
 * agentglass inherits the sidecar's whole set. The next install captures them
 * and replays them. Every install after that captures its own replay. From then
 * on `rotateToken` refuses, because AGENTGLASS_TOKEN is set — correctly, since
 * rotating a file the server does not read would report a revoke that did not
 * happen — and "Revoke this link" answers with a note about an environment
 * variable the user never set. It survived three attempts at rotating a leaked
 * token and took an Electron inspector session to find, because
 * /proc/<pid>/environ shows the exec-time snapshot and told us it was not there.
 *
 * The first fix for that only removed those seven from the REPLAY LIST, and
 * these tests only read the script's text, so they passed against a fix that
 * changed nothing: `env FOO=bar cmd` adds to the environment it was given, and
 * the update button gives the script the sidecar's. The assertions below run
 * the launch and read what came out of it.
 */
describe("what survives a reinstall", () => {
  const CAPTURE = readFileSync(new URL("../../electron/appctl.sh", import.meta.url), "utf8");
  /** How a shell inside agentglass — and the update script — is scoped. */
  const POLLUTED = {
    AGENTGLASS_TOKEN: "sidecar-token", AGENTGLASS_PORT: "4000", AGENTGLASS_BIND: "0.0.0.0",
    AGENTGLASS_TRUST_LAN: "1", AGENTGLASS_WEB_DIR: "/opt/web", AGENTGLASS_DIE_WITH_PARENT: "1",
    AGENTGLASS_PTY_SIZE_FILE: "/tmp/pty",
  };
  test("the two lists that hold the seven cannot drift apart", async () => {
    // One in bash and one in TypeScript, because they shut different doors —
    // `make desktop-update` from a terminal never goes through the server, and
    // the update button never goes through a clean shell. Different files, same
    // seven, so the way that fails is somebody adding an eighth to one of them.
    const { DERIVED_ENV } = await import("../src/selfupdate.ts");
    const inShell = /APPCTL_DERIVED=\(([^)]*)\)/.exec(CAPTURE)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
    expect([...inShell].sort()).toEqual([...DERIVED_ENV].sort());
    expect(inShell).toContain("AGENTGLASS_TOKEN");
  });

  test("the derived seven do not reach the reopened app, even from the shell", async () => {
    // The bug in one assertion. The replay list never held these; the
    // environment the installer was RUN IN did, and that is what the app
    // inherited. Exported here exactly as server/src/selfupdate.ts used to
    // hand them over.
    const app = fakeInstall();
    const main = launch(join(app, "agentglass"), blocker(app));
    await visible(app, [main]);

    const { out } = await appctl(app,
      `stop_app >/dev/null && start_app >/dev/null && ${AWAIT_MAIN} && tr "\\0" "\\n" < /proc/$(main_pids | head -n1)/environ`,
      POLLUTED);
    for (const v of Object.keys(POLLUTED)) expect(out, `${v} must not reach the app`).not.toContain(`${v}=`);
    cleanupInstall(app);
  });

  test("the scoping is read off the sidecar, which is the process that still has one", async () => {
    // Chromium rewrites the argv+environ block in place to set its process
    // title, so the Electron main has no environment left to read: measured on
    // the live app, /proc/<main>/environ is 2749 bytes with not one non-NUL
    // byte in it, against 78 variables in its sidecar. Reading the main is why
    // the scoping replay had never once happened on a real install.
    //
    // Hence the shape of this test: AGENTGLASS_ROOT is on the SIDECAR and
    // deliberately NOT on the main process, so a capture that reads the main
    // cannot pass it.
    const app = fakeInstall();
    const side = Bun.spawn([join(app, "resources", "agentglass-server"), "-c", blocker(app)], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, ...POLLUTED, AGENTGLASS_ROOT: "/tmp/scoped-repo" },
    });
    side.unref();
    spawned.push(side.pid);
    const main = launch(join(app, "agentglass"), `read x < ${join(app, "block")}`);
    await visible(app, [main, side.pid]);

    const { out } = await appctl(app,
      `stop_app >/dev/null && start_app >/dev/null && ${AWAIT_MAIN} && tr "\\0" "\\n" < /proc/$(main_pids | head -n1)/environ`,
      { APPCTL_GRACE_TENTHS: "5" });
    expect(out).toContain("AGENTGLASS_ROOT=/tmp/scoped-repo");
    // And the sidecar's own set, which is the polluted one by construction
    // (main.js spawns it with `{ ...process.env, AGENTGLASS_TOKEN: … }`), is
    // still filtered on the way through.
    expect(out).not.toContain("AGENTGLASS_TOKEN=");
    cleanupInstall(app);
  });

  test("the sidecar is found through the main's children, and by walking when it is not one", async () => {
    // The lookup reads /proc/<main>/task/<main>/children before it walks /proc,
    // because main.js spawns the sidecar and a walk costs 415-453 ms on this
    // machine against 3 ms for the read — the same cost _candidate_pids exists
    // to warn about, on a stop_app that already pays it twice.
    //
    // Both topologies, because "it had children" is NOT the test: an Electron
    // main always has helpers, so a lookup that stopped at the first non-empty
    // children file would silently miss an ADOPTED sidecar, which is nobody's
    // child.
    const app = fakeInstall();
    const fifo = blocker(app);
    const child = launch(join(app, "agentglass"),
      `${join(app, "resources", "agentglass-server")} -c '${fifo}' & ${fifo}`);
    await visible(app, [child]);
    const asChild = await appctl(app, 'sidecar_pids "$(main_pids | head -n1)"');
    expect(pids(asChild.out).length).toBe(1);
    cleanupInstall(app);

    // And the same install with the sidecar beside the main rather than under
    // it — no argument at all, which is the walk.
    const app2 = fakeInstall();
    const side = launch(join(app2, "resources", "agentglass-server"), blocker(app2));
    await visible(app2, [side]);
    expect(pids((await appctl(app2, "sidecar_pids")).out)).toEqual([side]);
    cleanupInstall(app2);
  });

  test("a command line Chromium has rewritten still yields its flags", async () => {
    // /proc/<pid>/cmdline is NUL-separated for an ordinary process and ONE
    // space-joined string for the Electron main — measured, zero NUL separators
    // where a /bin/sh with the same arguments has four. `tr '\0' '\n'` returned
    // a single line, `${args[@]:1}` was therefore empty, and every flag the
    // instance had was dropped on reopen.
    const rewritten = "/opt/agentglass --ozone-platform=wayland --no-sandbox";
    const both = await appctl("/unused",
      `printf '%s' "${rewritten}" | _split_cmdline; echo ---; printf '%s\\0%s\\0' /opt/agentglass --no-sandbox | _split_cmdline`);
    const [chromium, ordinary] = both.out.split("---").map((s) => s.trim().split("\n"));
    expect(chromium).toEqual(["/opt/agentglass", "--ozone-platform=wayland", "--no-sandbox"]);
    // And the NUL-separated form is untouched by the new branch.
    expect(ordinary).toEqual(["/opt/agentglass", "--no-sandbox"]);
  });
});

/*
 * And the second launch, which nobody meant to write.
 *
 * install-local.sh has ended with start_app since 22 July; self-update.sh then
 * launched another one unconditionally about a millisecond later, and
 * requestSingleInstanceLock picked. Measured over 20 runs against the real
 * binary: 1.2–1.6 ms between the launches, 79–101 ms of spread in reaching the
 * lock, and the SECOND one won 12 times out of 20 — while being the launch with
 * none of the arguments or scoping the first one carried.
 */
describe("the update script does not race the installer", () => {
  const SELFUPDATE = readFileSync(new URL("../../electron/self-update.sh", import.meta.url), "utf8");

  test("it only opens the app when the install reopened nothing", () => {
    expect(SELFUPDATE).toContain("main_pids");
    // The launch has to sit behind a test of what is running. Asserting on the
    // order is the point: an unconditional `setsid nohup "$BIN"` reads exactly
    // the same as a guarded one until you look at what precedes it.
    expect(SELFUPDATE.indexOf("main_pids")).toBeLessThan(SELFUPDATE.indexOf('setsid nohup "$BIN"'));
    expect(SELFUPDATE.match(/setsid nohup "\$BIN"/g)?.length ?? 0).toBe(1);
  });
});
