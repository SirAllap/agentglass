/*
 * Engines with no read wall of their own (OpenCode, Hermes, Antigravity, Claude with network/docker on)
 * run under bubblewrap with the app's credential dir hidden, or the start is refused naming
 * `workers.unwalledEngines`. The live probe needs user namespaces and skips where they are off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { bwrapWorks, bwrapped, headlessTurn, resetBwrapProbe, workerSshEnv, type TurnSpec } from "../src/agents/headless.ts";

const spec = (engine: string, extra: Partial<TurnSpec> = {}): TurnSpec => ({
  engine, bin: engine, model: "x/m", role: workerRole("builder")!, envelope: DEFAULT_WORKER_ENVELOPE,
  limits: { turnMinutes: 10 } as TurnSpec["limits"], prompt: "p", cwd: "/w/tree", runDir: "/w/run", ...extra,
} as TurnSpec);

const PATH = process.env.PATH;
afterEach(() => { process.env.PATH = PATH; resetBwrapProbe(); });

describe("bwrap wall", () => {
  test("argv hides an existing dir with tmpfs and skips a missing one", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-bw-"));
    const a = bwrapped(["cat", "x"], [d, join(d, "nope")]);
    expect(a.slice(0, 3)).toEqual(["bwrap", "--dev-bind", "/"]);
    expect(a.join(" ")).toContain(`--tmpfs ${d} `);
    expect(a.join(" ")).not.toContain("nope");
    expect(a.slice(-3)).toEqual(["--", "cat", "x"]);
  });
  test("no bwrap: OpenCode is refused naming the setting, unless accepted", () => {
    process.env.PATH = "/nonexistent"; resetBwrapProbe();
    expect(bwrapWorks()).toBe(false);
    const t = headlessTurn(spec("opencode"));
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain("workers.unwalledEngines");
    expect(headlessTurn(spec("opencode", { unwalledEngines: true })).ok).toBe(true);
  });
  test("claude with its sandbox held is not wrapped; with network on and no bwrap it is refused", () => {
    process.env.PATH = "/nonexistent"; resetBwrapProbe();
    const held = headlessTurn(spec("claude"));
    expect(held.ok).toBe(true);
    const open = headlessTurn(spec("claude", { envelope: { ...DEFAULT_WORKER_ENVELOPE, network: true } }));
    expect(open.ok).toBe(false);
  });
  test.skipIf(!bwrapWorks())("LIVE: a canary under the config dir cannot be read through the wrapped argv", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-bw-home-"));
    const cfg = join(home, ".config", "agentglass");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "token"), "CANARY-123");
    const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(run(["cat", join(cfg, "token")]).stdout.toString()).toBe("CANARY-123");
    const r = run(bwrapped(["sh", "-c", `cd ${join(home, ".config")} && cat agent*/tok*`], [cfg]));
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).not.toContain("CANARY");
  });

  test("argv also hides the runtime dir and tmux socket dirs, and unsets the socket variables", () => {
    const rt = mkdtempSync(join(tmpdir(), "agx-rt-"));
    const tm = mkdtempSync(join(tmpdir(), "agx-tm-"));
    const old = { r: process.env.XDG_RUNTIME_DIR, t: process.env.TMUX_TMPDIR };
    process.env.XDG_RUNTIME_DIR = rt; process.env.TMUX_TMPDIR = tm;
    try {
      const a = bwrapped(["true"], []).join(" ");
      expect(a).toContain(`--tmpfs ${rt} `);
      expect(a).toContain(`--tmpfs ${tm} `);
      for (const v of ["TMUX", "TMUX_PANE", "SSH_AUTH_SOCK"]) expect(a).toContain(`--unsetenv ${v}`);
      expect(a).toContain("--setenv DBUS_SESSION_BUS_ADDRESS unix:path=/nonexistent");
      const real = bwrapped(["true"], [], { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }).join(" ");
      expect(real).not.toContain("/run/user/1000/bus");
    } finally {
      if (old.r === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = old.r;
      if (old.t === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = old.t;
    }
  });
  test.skipIf(!bwrapWorks() || !Bun.which("gh"))("LIVE: gh auth token returns within 5 s inside the wall", () => {
    const t0 = Date.now();
    Bun.spawnSync(bwrapped(["timeout", "5", "gh", "auth", "token"], []), { stdout: "pipe", stderr: "pipe" });
    expect(Date.now() - t0).toBeLessThan(6000);
  });
  test("the socket dir named by $TMUX is hidden too", () => {
    const d = mkdtempSync(join(tmpdir(), "agx-tmx-"));
    const a = bwrapped(["true"], [], { TMUX: `${d}/default,123,0` }).join(" ");
    expect(a).toContain(`--tmpfs ${d} `);
  });
  test("claude with unix sockets on is walled too", () => {
    const t = headlessTurn(spec("claude", { unixSockets: "all" }));
    if (bwrapWorks()) expect(t.ok && t.argv[0]).toBe("bwrap");
    else expect(t.ok).toBe(false);
  });
  const live = (name: string, body: (tm: string, cfg: string, canary: string) => void) =>
    test.skipIf(!bwrapWorks() || !Bun.which("tmux"))(`LIVE: ${name}`, () => {
      const tm = mkdtempSync(join(tmpdir(), "agx-bw-tmux-"));
      const cfg = join(mkdtempSync(join(tmpdir(), "agx-bw-cfg-")), "agentglass");
      mkdirSync(cfg, { recursive: true });
      const canary = join(cfg, "token");
      writeFileSync(canary, "CANARY-456");
      try { body(tm, cfg, canary); }
      finally { Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", "agxbw", "kill-server"], { env: { ...process.env, TMUX_TMPDIR: tm } }); }
    });
  const outside = (tm: string, ...a: string[]) => Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", "agxbw", ...a], { env: { ...process.env, TMUX_TMPDIR: tm }, stdout: "pipe", stderr: "pipe" });
  live("tmux run-shell through an outside server cannot read the hidden file", (tm, cfg, canary) => {
    expect(outside(tm, "new-session", "-d", "sh").exitCode).toBe(0);
    const env = { ...process.env, TMUX_TMPDIR: tm };
    const r = Bun.spawnSync(bwrapped(["tmux", ...TMUX_ISOLATED, "-L", "agxbw", "run-shell", `cat ${canary}`], [cfg], env), { env, stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString()).not.toContain("CANARY");
  });
  live("tmux send-keys into an outside pane through the socket path is refused", (tm, cfg, canary) => {
    expect(outside(tm, "new-session", "-d", "-s", "p", "sh").exitCode).toBe(0);
    const sock = join(tm, `tmux-${process.getuid!()}`, "agxbw");
    const r = Bun.spawnSync(bwrapped(["tmux", "-S", sock, "send-keys", "-t", "p", `cat ${canary} > ${tm}/leak`, "Enter"], [cfg], { ...process.env, TMUX_TMPDIR: tm }), { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    Bun.sleepSync(300);
    expect(Bun.file(join(tm, "leak")).size).toBe(0);
  });
  live("systemd-run --user cannot reach the session bus", (_tm, cfg, canary) => {
    if (!Bun.which("systemd-run")) return;
    const r = Bun.spawnSync(bwrapped(["systemd-run", "--user", "--wait", "--pipe", "-q", "cat", canary], [cfg]), { stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString()).not.toContain("CANARY");
  });
  live("/proc/<host pid>/root/<hidden file> is refused", (_tm, cfg, canary) => {
    const r = Bun.spawnSync(bwrapped(["sh", "-c", `cat /proc/${process.pid}/root${canary}`], [cfg]), { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).not.toContain("CANARY");
  });
});

describe("worker ssh", () => {
  test("a worker's git push skips the system ssh config its namespace cannot own-check", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-ssh-"));
    expect(workerSshEnv({}, home).GIT_SSH_COMMAND).toBe("ssh -F '/dev/null'");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "config"), "Host acme\n  User git\n");
    expect(workerSshEnv({}, home).GIT_SSH_COMMAND).toBe(`ssh -F '${join(home, ".ssh", "config")}'`);
    // The person's own choice wins, from either environment.
    expect(workerSshEnv({ GIT_SSH_COMMAND: "ssh -i k" }, home)).toEqual({});
    expect(workerSshEnv({ GIT_SSH: "/bin/x" }, home)).toEqual({});
  });
  test("a turn carries it, and a turn's own GIT_SSH_COMMAND is kept", () => {
    const t = headlessTurn(spec("opencode", { unwalledEngines: true }));
    expect(t.ok && t.env.GIT_SSH_COMMAND).toMatch(/^ssh -F '/);
  });
  test.skipIf(!bwrapWorks() || !Bun.which("ssh"))("live: ssh inside the namespace reads the config it was given", () => {
    const home = mkdtempSync(join(tmpdir(), "agx-ssh-"));
    const cmd = workerSshEnv({}, home).GIT_SSH_COMMAND! + " -G acme.example";
    const r = Bun.spawnSync(bwrapped(["sh", "-c", cmd]), { stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).not.toContain("Bad owner");
    expect(r.stdout.toString()).toContain("hostname acme.example");
  });
});
