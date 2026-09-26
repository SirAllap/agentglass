// Two installs that overlap lose the app.
//
// install-local.sh stops the running instance, replaces its files and reopens
// what it stopped. A second install that starts while the first has the app
// down finds nothing running, so it captures nothing to reopen; the first then
// reopens the app, and the second replaces the files under that fresh
// instance and reopens nothing. Measured on 2026-09-25 with three installs a
// few minutes apart: the reopened instance lived twenty-one seconds and the
// desktop was left with no app.
//
// These drive electron/appctl.sh against a fake install, like
// install-stop.test.ts, and model "replace the files" as the one thing it
// means for a running instance: it does not survive.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APPCTL, AWAIT_MAIN, fakeInstall as sharedFakeInstall } from "./fakeInstall.ts";

const INSTALLER = await Bun.file(join(import.meta.dir, "..", "..", "electron", "install-local.sh")).text();

const apps: string[] = [];
function fakeInstall() {
  const app = sharedFakeInstall("agx-install-lock-");
  apps.push(app);
  return app;
}

function sh(app: string, call: string, env: Record<string, string> = {}) {
  return Bun.spawn(["bash", "-c", `APP="${app}"; . "${APPCTL}"; ${call}`], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
}
async function run(app: string, call: string, env: Record<string, string> = {}) {
  const p = sh(app, call, env);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}
const mains = async (app: string) => (await run(app, "main_pids")).out.split("\n").filter((l) => /^\d+$/.test(l));

/** The installer's critical section, with the copy stood in for by killing
 *  whatever runs out of the install while it is being replaced. `before` runs
 *  between the stop and the copy, `after` once the app is reopened. */
const INSTALL = (lock: boolean, before = "", after = "") =>
  `${lock ? "take_install_lock || exit 3; " : ""}stop_app || exit 1; ${before} ` +
  `kill -9 $(app_pids) 2>/dev/null; start_app; ${AWAIT_MAIN}; ${after}`;
/** Wait, bounded, for a file another install touches. */
const until = (file: string, tenths: number) =>
  `for _ in $(seq ${tenths * 2}); do [ -e "${file}" ] && break; sleep 0.05; done;`;

afterEach(() => {
  for (const app of apps.splice(0)) {
    const left = Bun.spawnSync(["bash", "-c", `APP="${app}"; . "${APPCTL}"; app_pids`], { stdout: "pipe" })
      .stdout.toString().split("\n").filter(Boolean);
    for (const pid of left) { try { process.kill(Number(pid), 9); } catch { /* gone */ } }
    rmSync(app, { recursive: true, force: true });
    rmSync(`${app}.install.lock`, { force: true });
  }
});

async function race(lock: boolean): Promise<{ codes: number[]; running: string[] }> {
  const app = fakeInstall();
  const fifo = join(app, "block");
  Bun.spawnSync(["mkfifo", fifo]);
  const first = Bun.spawn([join(app, "agentglass"), "-c", `read x < ${fifo}`], { stdio: ["ignore", "ignore", "ignore"] });
  first.unref();
  for (let i = 0; i < 200 && (await mains(app)).length === 0; i++) await Bun.sleep(25);
  /* The order the incident had, forced by handshake rather than by timing,
     which a loaded machine does not keep: the second checks for a running app
     while the first has it down, and replaces the files only after the first
     has reopened it. With the lock the second cannot check yet, so the first
     stops waiting for it after a second and carries on. */
  const [aDown, bDown, aUp] = ["a.stopped", "b.stopped", "a.started"].map((f) => join(app, f));
  const a = sh(app, INSTALL(lock, `touch ${aDown}; ${until(bDown, 10)}`, `touch ${aUp}`));
  for (let i = 0; i < 400 && !existsSync(aDown); i++) await Bun.sleep(25);
  const b = sh(app, INSTALL(lock, `touch ${bDown}; ${until(aUp, 100)}`));
  const codes = await Promise.all([a.exited, b.exited]);
  return { codes, running: await mains(app) };
}

describe("installs that overlap", () => {
  test("without the lock the second install loses the app (the incident, reproduced)", async () => {
    const r = await race(false);
    expect(r.codes).toEqual([0, 0]);
    expect(r.running).toHaveLength(0);
  }, 40_000);

  test("with the lock the second waits, stops what the first reopened, and reopens it", async () => {
    const r = await race(true);
    expect(r.codes).toEqual([0, 0]);
    expect(r.running).toHaveLength(1);
  }, 40_000);

  test("the reopened app does not inherit the lock, or every later install would wait on it", async () => {
    const app = fakeInstall();
    const fifo = join(app, "block");
    Bun.spawnSync(["mkfifo", fifo]);
    const first = Bun.spawn([join(app, "agentglass"), "-c", `read x < ${fifo}`], { stdio: ["ignore", "ignore", "ignore"] });
    first.unref();
    for (let i = 0; i < 200 && (await mains(app)).length === 0; i++) await Bun.sleep(25);
    expect((await run(app, INSTALL(true))).code).toBe(0);
    expect(await mains(app)).toHaveLength(1);
    const again = await run(app, "take_install_lock", { APPCTL_LOCK_WAIT_S: "1" });
    expect(again.code).toBe(0);
  }, 40_000);

  test("the installer takes the lock before it stops anything", () => {
    const lock = INSTALLER.indexOf("\ntake_install_lock");
    const stop = INSTALLER.indexOf("\nif ! stop_app");
    expect(lock).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(lock);
  });

  test("a directory it cannot write is said plainly, not waited on", async () => {
    const app = fakeInstall();
    const ro = join(app, "ro");
    mkdirSync(ro, { mode: 0o500 });
    const r = await run(join(ro, "app"), "take_install_lock");
    Bun.spawnSync(["chmod", "700", ro]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("cannot create the install lock");
    expect(r.out).not.toContain("waiting");
  });
});
