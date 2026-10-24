/*
 * The second layer around a boxed plugin: Landlock through setpriv, laid
 * inside the bwrap box (see `landlockProbe` in server/src/plugin-sandbox.ts).
 *
 * Three claims, each against the thing that makes it true:
 *  - the argv: setpriv wraps the plugin, never the bridge, with rights that
 *    mirror each mount — pure, so it runs everywhere;
 *  - the kernel: a ruleset built by `landlockArgv` refuses a key folder and a
 *    sibling plugin's data folder with no mount namespace involved at all;
 *  - the box: a directory descriptor leaked into a bwrap-only box reads a file
 *    outside it through /proc/self/fd, and the same box with setpriv does not.
 * The last two need a kernel with Landlock (and bwrap for the third); where it
 * is missing they are skipped and the probe test says why.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetLandlockProbe, __resetSandboxProbe, hostResolvConfExtraRo, hostSystemPaths, landlockArgv, landlockProbe,
  openGrantFds, resolveGrants, sandboxArgv, sandboxProbe, type SandboxArgvInput,
} from "../src/plugin-sandbox.ts";
import type { PluginSandbox } from "../../shared/pluginSandbox.ts";

const ORIGINAL_SETPRIV = process.env.AGENTGLASS_SETPRIV;
const root = mkdtempSync(join(tmpdir(), "agx-landlock-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (ORIGINAL_SETPRIV === undefined) delete process.env.AGENTGLASS_SETPRIV; else process.env.AGENTGLASS_SETPRIV = ORIGINAL_SETPRIV;
  __resetLandlockProbe();
  __resetSandboxProbe();
});
beforeEach(() => {
  delete process.env.AGENTGLASS_SETPRIV;
  __resetLandlockProbe();
});

const SANDBOX: PluginSandbox = { network: "internet", read: [], write: [], programs: [] };

function input(over: Partial<SandboxArgvInput> = {}): SandboxArgvInput {
  return {
    bwrap: "/usr/bin/bwrap",
    installDir: "/home/orbit/.config/agentglass/plugins/acme",
    dataDir: "/home/orbit/.local/share/agentglass/plugin-data/acme",
    home: "/home/orbit",
    entrypoint: "python3 -u reviewer.py",
    env: { PATH: "/usr/bin", AGENTGLASS_URL: "http://127.0.0.1:4000" },
    sandbox: SANDBOX,
    grants: {
      read: [{ dest: "/home/orbit/notes", childFd: 3, isDir: true }, { dest: "/home/orbit/.gitconfig", childFd: 4, isDir: false }],
      write: [{ dest: "/home/orbit/out", childFd: 5, isDir: true }],
    },
    programDirs: [],
    systemLinks: [],
    systemDirs: ["/etc"],
    extraRo: [],
    ...over,
  };
}

const rule = (argv: string[], path: string) => argv.find((a, i) => argv[i - 1] === "--landlock-rule" && a.endsWith(`:${path}`));

describe("sandboxArgv with setpriv", () => {
  const argv = sandboxArgv(input({ setpriv: "/usr/bin/setpriv" }));

  test("wraps the entrypoint, after every bwrap flag", () => {
    const at = argv.indexOf("/usr/bin/setpriv");
    expect(at).toBeGreaterThan(argv.indexOf("--chdir"));
    expect(argv.slice(at, at + 3)).toEqual(["/usr/bin/setpriv", "--landlock-access", "fs"]);
    expect(argv.slice(-4)).toEqual(["--", "bash", "-c", "python3 -u reviewer.py"]);
  });

  test("rights mirror the mounts: read grants read-only, write grants and the data folder writable, a file without read-dir", () => {
    expect(rule(argv, "/home/orbit/notes")).toBe("path-beneath:read-file,read-dir,execute:/home/orbit/notes");
    expect(rule(argv, "/home/orbit/.gitconfig")).toBe("path-beneath:read-file,execute:/home/orbit/.gitconfig");
    expect(rule(argv, "/home/orbit/out")).toStartWith("path-beneath:read-file,read-dir,execute,write-file,");
    expect(rule(argv, "/home/orbit/.local/share/agentglass/plugin-data/acme")).toContain("write-file");
    expect(rule(argv, "/home/orbit/.config/agentglass/plugins/acme")).toBe("path-beneath:read-file,read-dir,execute:/home/orbit/.config/agentglass/plugins/acme");
    expect(rule(argv, "/usr")).not.toContain("write-file");
  });

  test("absent setpriv leaves the argv exactly as before", () => {
    const plain = sandboxArgv(input());
    expect(plain.some((a) => a.includes("landlock"))).toBe(false);
    expect(plain.slice(-3)).toEqual(["bash", "-c", "python3 -u reviewer.py"]);
  });

  test("network: agentglass — setpriv goes after the bridge, which is not wrapped and whose binds get no rule", () => {
    const net = sandboxArgv(input({
      sandbox: { ...SANDBOX, network: "agentglass" },
      setpriv: "/usr/bin/setpriv",
      network: { socketHostPath: "/run/user/1000/agentglass/plugin.sock", bridgeExec: ["/opt/agentglass/server"], bridgeRo: ["/opt/agentglass/server"] },
    }));
    const bridge = net.indexOf("plugin-bridge");
    const sp = net.indexOf("/usr/bin/setpriv");
    expect(bridge).toBeGreaterThan(-1);
    expect(sp).toBe(net.indexOf("--", bridge) + 1);
    expect(rule(net, "/opt/agentglass/server")).toBeUndefined();
  });
});

describe("landlockProbe", () => {
  function stub(name: string, body: string): string {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("a setpriv that cannot lay a ruleset: no layer, no throw", () => {
    process.env.AGENTGLASS_SETPRIV = stub("setpriv-no-kernel", 'echo "setpriv: landlock_create_ruleset failed: Operation not supported" >&2; exit 1');
    const p = landlockProbe();
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.detail).toContain("Operation not supported");
  });

  test("a setpriv that ignores the flags and refuses nothing is not trusted as a layer", () => {
    process.env.AGENTGLASS_SETPRIV = stub("setpriv-ignores", 'shift $(($# - 1)); exec "$1"');
    expect(landlockProbe().ok).toBe(false);
  });

  test("a setpriv that predates one right a start uses is not trusted (it would fail every start)", () => {
    process.env.AGENTGLASS_SETPRIV = stub("setpriv-2.40", 'case "$*" in *ioctl-dev*) echo "setpriv: could not parse landlock fs access: ioctl-dev" >&2; exit 1;; esac; shift $(($# - 1)); exec "$1"');
    const p = landlockProbe();
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.detail).toContain("ioctl-dev");
  });

  test("a timeout is not cached as off for the life of the process", () => {
    process.env.AGENTGLASS_SETPRIV = stub("setpriv-slow", "sleep 5");
    const slow = landlockProbe();
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.timedOut).toBe(true);
    process.env.AGENTGLASS_SETPRIV = stub("setpriv-no-kernel-2", 'echo "no landlock" >&2; exit 1');
    const next = landlockProbe();
    expect(!next.ok && next.detail).toBe("no landlock");
  }, 10_000);

  test("this host", () => {
    const p = landlockProbe();
    if (!p.ok) console.log(`[landlock] not on this host, kernel tests below skip: ${p.detail}`);
    expect(typeof p.ok).toBe("boolean");
  });
});

// Source, because buildBoxArgv opens fds and a socket, and publicProbe is
// private: without these lines the layer is silently never laid.
const pluginsSrc = await Bun.file(join(import.meta.dir, "../src/plugins.ts")).text();
function fnBody(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("\n}\n", at));
}
describe("plugins.ts lays the layer", () => {
  test("buildBoxArgv hands sandboxArgv the probed setpriv", () => {
    expect(fnBody(pluginsSrc, "async function buildBoxArgv(")).toContain("setpriv: landlock.ok ? landlock.setpriv : undefined");
  });
  test("the public probe carries whether it is there", () => {
    expect(fnBody(pluginsSrc, "function publicProbe(")).toContain("landlock: landlockProbe().ok");
  });
});

__resetLandlockProbe();
const hostLandlock = landlockProbe();
__resetLandlockProbe();

describe.skipIf(!hostLandlock.ok)("the kernel refuses what the ruleset does not grant", () => {
  const setpriv = hostLandlock.ok ? hostLandlock.setpriv : "";
  const k = join(root, "kernel");
  const sshKey = join(k, "home", ".ssh", "id_fixture");
  const sibling = join(k, "plugin-data", "orbit", "state.json");
  const data = join(k, "plugin-data", "acme");
  const notes = join(k, "home", "notes");
  mkdirSync(join(k, "home", ".ssh"), { recursive: true });
  mkdirSync(join(k, "plugin-data", "orbit"), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(notes, { recursive: true });
  writeFileSync(sshKey, "fixture key\n");
  writeFileSync(sibling, "{}\n");
  writeFileSync(join(notes, "a.txt"), "granted\n");
  const ll = landlockArgv(setpriv, {
    ro: [{ path: "/usr", isDir: true }, { path: "/etc", isDir: true }, { path: notes, isDir: true }],
    dev: ["/dev"],
    rw: [{ path: data, isDir: true }],
  });

  async function sh(script: string): Promise<{ code: number; out: string }> {
    const p = Bun.spawn([...ll, "bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  }

  test("a key folder and a sibling plugin's data are refused", async () => {
    expect((await sh(`cat ${sshKey}`)).out).toContain("Permission denied");
    expect((await sh(`cat ${sibling}`)).out).toContain("Permission denied");
  });

  test("declared grants still work: read grant readable not writable, data folder writable", async () => {
    expect((await sh(`cat ${join(notes, "a.txt")}`)).out).toBe("granted\n");
    expect((await sh(`echo x > ${join(notes, "b.txt")}`)).out).toContain("Permission denied");
    expect((await sh(`echo x > ${join(data, "w")} && cat ${join(data, "w")}`)).out).toBe("x\n");
  });
});

describe.skipIf(!hostLandlock.ok || !sandboxProbe().ok)("a leaked descriptor inside the real box", () => {
  const b = join(root, "box");
  const home = join(b, "home");
  const outside = join(b, "outside", ".ssh");
  mkdirSync(join(home, "notes"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(b, "install"), { recursive: true });
  mkdirSync(join(b, "data"), { recursive: true });
  writeFileSync(join(home, "notes", "a.txt"), "granted\n");
  writeFileSync(join(home, ".orbitrc"), "file grant\n");
  writeFileSync(join(outside, "id_fixture"), "fixture key\n");

  async function run(setpriv: string | undefined): Promise<string> {
    const probe = sandboxProbe();
    if (!probe.ok) throw new Error("unreachable: skipped without bwrap");
    const opened = openGrantFds(resolveGrants({ ...SANDBOX, read: ["~/notes", "~/.orbitrc"] }, home), home);
    expect(opened.read.length).toBe(2);
    // The leak: one more descriptor, to a folder the box never mounts, at the fd after the grant's.
    const leaked = openSync(outside, "r");
    const leakedFd = 3 + opened.parentFds.length;
    const { systemDirs, systemLinks } = hostSystemPaths();
    const argv = sandboxArgv({
      bwrap: probe.bwrap, installDir: join(b, "install"), dataDir: join(b, "data"), home,
      entrypoint: `cat ${join(home, "notes", "a.txt")} ${join(home, ".orbitrc")}; cat /proc/self/fd/${leakedFd}/id_fixture`,
      env: { PATH: "/usr/bin:/bin", AGENTGLASS_URL: "http://127.0.0.1:4000" }, sandbox: SANDBOX,
      grants: { read: opened.read, write: opened.write }, programDirs: [], systemLinks, systemDirs,
      extraRo: hostResolvConfExtraRo(), setpriv,
    });
    const p = Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe", ...opened.parentFds, leaked], env: { PATH: "/usr/bin:/bin" } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    for (const fd of [...opened.parentFds, leaked]) closeSync(fd);
    return out + err;
  }

  test("bwrap alone: the leak reads outside the box (the hole this layer closes)", async () => {
    expect(await run(undefined)).toContain("fixture key");
  });

  test("bwrap + Landlock: the grant still reads, the leak is refused", async () => {
    const out = await run(hostLandlock.ok ? hostLandlock.setpriv : undefined);
    expect(out).toContain("granted");
    expect(out).toContain("file grant");
    expect(out).not.toContain("fixture key");
    expect(out).toContain("Permission denied");
  });
});
