// An install run over ssh has no display in its environment, and the app it
// reopened inherited that: Electron died with SIGSEGV in uv_close within a
// second of launch, once per ssh install (six cores, each under the ssh
// session's own cgroup scope). The graphical session's variables live in the
// user manager, so start_app borrows only those, and when there is still no
// display it says so instead of launching an instance that cannot survive.
//
// Same fake install as install-stop.test.ts: a real directory, a real binary,
// and the reopened process's /proc/<pid>/environ as the evidence.
import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPCTL, AWAIT_MAIN, fakeInstall } from "./fakeInstall.ts";

const spawned: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, 9); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A running instance that blocks on a fifo (start_app gives the app /dev/null). */
function running(app: string): number {
  const fifo = join(app, "block");
  Bun.spawnSync(["mkfifo", fifo]);
  const p = Bun.spawn([join(app, "agentglass"), "-c", `read x < ${fifo}`], { stdio: ["pipe", "ignore", "ignore"] });
  p.unref();
  spawned.push(p.pid);
  return p.pid;
}

/** A `systemctl` first on PATH that answers `--user show-environment` with `lines`. */
function fakeSystemctl(lines: string[]): string {
  const dir = join(fakeInstall("agx-systemctl-"), "bin");
  mkdirSync(dir);
  dirs.push(dir);
  writeFileSync(join(dir, "systemctl"),
    `#!/bin/sh\n[ "$1 $2" = "--user show-environment" ] || exit 1\ncat <<'EOF2'\n${lines.join("\n")}\nEOF2\n`);
  chmodSync(join(dir, "systemctl"), 0o755);
  return dir;
}

const SESSION = [
  "WAYLAND_DISPLAY=wayland-1",
  "DISPLAY=:0",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "HYPRLAND_INSTANCE_SIGNATURE=abc123",
  "XDG_SESSION_TYPE=wayland",
  "SOME_OTHER_THING=must-not-leak",
];

/** Reopen from an environment shaped like the caller's: no display unless given. */
async function reopen(app: string, env: Record<string, string>, path?: string, expectMain = true) {
  const base: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of ["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "HYPRLAND_INSTANCE_SIGNATURE", "XDG_SESSION_TYPE", "SOME_OTHER_THING"]) delete base[k];
  const p = Bun.spawn(["bash", "-c",
    `APP="${app}"; . "${APPCTL}"; stop_app >/dev/null; start_app 2>&1; ` +
    `${expectMain ? AWAIT_MAIN : "sleep 0.3"}; for _ in 1 2 3; do sleep 0.1; done; ` +
    `m=$(main_pids | head -n1); [ -n "$m" ] && tr "\\0" "\\n" < /proc/$m/environ; true`], {
    env: { ...base, ...(path ? { PATH: `${path}:${base.PATH}` } : {}), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

const cleanup = (app: string) => {
  const r = Bun.spawnSync(["bash", "-c", `APP="${app}"; . "${APPCTL}"; app_pids`], { stdout: "pipe" });
  for (const pid of r.stdout.toString().split("\n").filter(Boolean)) { try { process.kill(Number(pid), 9); } catch { /* gone */ } }
  rmSync(app, { recursive: true, force: true });
};

describe("reopening from a shell with no display", () => {
  test("the display and session variables come from the user manager, and nothing else does", async () => {
    const app = fakeInstall();
    running(app);
    const out = await reopen(app, {}, fakeSystemctl(SESSION));
    expect(out).toContain("WAYLAND_DISPLAY=wayland-1");
    expect(out).toContain("DISPLAY=:0");
    expect(out).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    expect(out).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
    expect(out).toContain("HYPRLAND_INSTANCE_SIGNATURE=abc123");
    expect(out).toContain("XDG_SESSION_TYPE=wayland");
    expect(out).not.toContain("SOME_OTHER_THING");
    cleanup(app);
  });

  test("no display anywhere: nothing is launched, one line says why and how", async () => {
    const app = fakeInstall();
    running(app);
    const out = await reopen(app, {}, fakeSystemctl(["XDG_RUNTIME_DIR=/run/user/1000"]), false);
    expect(out).toContain("not reopened");
    expect(out).toContain("no graphical session");
    expect(out).toContain("gtk-launch agentglass.desktop");
    expect(out).not.toContain("reopening");
    // The environment dump of a reopened main is the only other thing on stdout.
    expect(out).not.toContain("XDG_RUNTIME_DIR=");
    cleanup(app);
  });

  test("a failing systemctl is the same as no display, and still exits 0", async () => {
    const app = fakeInstall();
    running(app);
    const dir = join(fakeInstall("agx-systemctl-"), "bin");
    mkdirSync(dir);
    dirs.push(dir);
    writeFileSync(join(dir, "systemctl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "systemctl"), 0o755);
    const p = Bun.spawn(["bash", "-c", `APP="${app}"; . "${APPCTL}"; stop_app >/dev/null; start_app; echo "code=$?"`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WAYLAND_DISPLAY: "", DISPLAY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    expect(out).toContain("not reopened");
    expect(out).toContain("code=0");
    cleanup(app);
  });
});

describe("reopening from a shell that has a display", () => {
  test("a display already set is never overwritten", async () => {
    const app = fakeInstall();
    running(app);
    const out = await reopen(app, { WAYLAND_DISPLAY: "wayland-9" }, fakeSystemctl(SESSION));
    expect(out).toContain("WAYLAND_DISPLAY=wayland-9");
    expect(out).not.toContain("WAYLAND_DISPLAY=wayland-1");
    // Nothing is borrowed either: the shell already has its own session.
    expect(out).not.toContain("HYPRLAND_INSTANCE_SIGNATURE=abc123");
    cleanup(app);
  });

  test("only DISPLAY set counts as a display too", async () => {
    const app = fakeInstall();
    running(app);
    const out = await reopen(app, { DISPLAY: ":7" }, fakeSystemctl(SESSION));
    expect(out).toContain("DISPLAY=:7");
    expect(out).not.toContain("WAYLAND_DISPLAY=wayland-1");
    cleanup(app);
  });
});

describe("nothing was running", () => {
  test("nothing is reopened and nothing is said about a display", async () => {
    const app = fakeInstall();
    const p = Bun.spawn(["bash", "-c", `APP="${app}"; . "${APPCTL}"; stop_app >/dev/null; start_app 2>&1`], {
      env: { ...process.env, PATH: `${fakeSystemctl(SESSION)}:${process.env.PATH}`, WAYLAND_DISPLAY: "", DISPLAY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toBe("");
    cleanup(app);
  });
});
