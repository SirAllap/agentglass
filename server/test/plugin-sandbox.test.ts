/*
 * Slice 2: the box itself.
 *
 * `sandboxArgv` is pure and pinned exactly — the flags a reader would have
 * to trust blindly otherwise, checked as exact contiguous triples and in
 * order, not just membership (a membership check stays green when `--bind`
 * silently becomes `--ro-bind`, or the reverse). `resolveGrants` is where a
 * manifest's `~/…` spelling meets the real filesystem, and a symlink between
 * review and enable is the one attack `validateSandbox` in
 * shared/pluginSandbox.ts cannot see, because it only ever looked at the
 * spelling. `openGrantFds` closes the gap a resolved-but-not-yet-mounted
 * grant still has. The real-bwrap test is the only one of these that proves
 * anything about the actual box rather than the code that describes it, and
 * it skips honestly — logged, not silently — on a host that cannot build
 * one. This harness forces every test's HOME under `/tmp`
 * (server/test/isolation.ts), so the real-box fixture's home is a `/tmp`
 * descendant whatever this file does — `refusalReason` in plugin-sandbox.ts
 * carries an explicit exception for exactly that (a real HOME is never under
 * `/tmp`, but a test's is), and the "break it" test below strips BOTH
 * `--tmpfs /tmp` and `--tmpfs home` for the same reason: here, the outer one
 * would otherwise stand in for the one this test exists to prove matters.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSandboxProbe, hostResolvConfExtraRo, hostSystemPaths, openGrantFds, PLUGIN_SOCKET_BOX_PATH, pluginDataDir, resolveGrants,
  resolvePrograms, sandboxArgv, sandboxProbe, type SandboxArgvInput,
} from "../src/plugin-sandbox.ts";
import { ensurePluginSocketServer, pluginSocketPath, setPluginSocketHandler, stopPluginSocketServer } from "../src/plugin-socket.ts";
import { mintPluginToken } from "../src/auth.ts";
import { boxExtraRo } from "../src/plugins.ts";
import type { PluginSandbox } from "../../shared/pluginSandbox.ts";
import { freePort } from "./freePort.ts";

const roots: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
/** Under `.cache` rather than the bare scratch root — cosmetically closer to
 *  a real home's layout. Still, in THIS harness, a `/tmp` descendant either
 *  way; see the file header. */
function scratchOutsideTmp(prefix: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  roots.push(dir);
  return dir;
}

// `bun test` runs every file in one process — these are globals every other
// test reads (`XDG_CONFIG_HOME` for its own store, `AGENTGLASS_BWRAP` for
// its own probe), so what this file sets it also puts back.
const ORIGINAL = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGENTGLASS_BWRAP: process.env.AGENTGLASS_BWRAP,
  AGENTGLASS_SANDBOX_USERNS_SYSCTL: process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL,
};
afterAll(() => {
  for (const dir of roots) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __resetSandboxProbe();
});

beforeEach(() => {
  delete process.env.AGENTGLASS_BWRAP;
  delete process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL;
  __resetSandboxProbe();
});

const NO_SANDBOX: PluginSandbox = { network: "agentglass", read: [], write: [], programs: [] };

// `describe("sandboxArgv")` below pins the shape shared by both networks —
// grants, HOME, PATH, the data dir — so it fixes network: "internet", which
// needs no extra input, and the network split gets its own two describes
// further down.
const INTERNET_SANDBOX: PluginSandbox = { ...NO_SANDBOX, network: "internet" };

function baseInput(over: Partial<SandboxArgvInput> = {}): SandboxArgvInput {
  return {
    bwrap: "/usr/bin/bwrap",
    installDir: "/home/orbit/.config/agentglass/plugins/orbit-plugin",
    dataDir: "/home/orbit/.config/agentglass/plugin-data/orbit-plugin",
    home: "/home/orbit",
    entrypoint: "python3 -u reviewer.py",
    env: { PATH: "/usr/local/bin:/usr/bin:/home/orbit/.local/bin", AGENTGLASS_URL: "http://127.0.0.1:4000" },
    sandbox: INTERNET_SANDBOX,
    grants: {
      read: [{ dest: "/home/orbit/.config/orbit-data", childFd: 3, isDir: true }],
      write: [{ dest: "/home/orbit/.local/share/orbit-plugin", childFd: 4, isDir: true }],
    },
    programDirs: ["/home/orbit/.volta/bin"],
    systemLinks: [{ path: "/bin", target: "usr/bin" }],
    systemDirs: ["/etc", "/opt"],
    extraRo: ["/run/systemd/resolve"],
    ...over,
  };
}

/** Finds a flag followed by exactly `args` as a CONTIGUOUS run, returning its
 *  index — unlike `arrayContaining`, this fails the moment `--bind` becomes
 *  `--ro-bind`, an extra arg is inserted, or the flag is dropped, because
 *  membership alone does not notice any of those. */
function exactAt(argv: string[], flag: string, ...args: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    if (args.every((a, j) => argv[i + 1 + j] === a)) return i;
  }
  return -1;
}

describe("sandboxArgv", () => {
  const argv = sandboxArgv(baseInput());
  const joined = argv.join(" ");

  test("starts with bwrap and ends with bash -c <entrypoint>", () => {
    expect(argv[0]).toBe("/usr/bin/bwrap");
    expect(argv.slice(-3)).toEqual(["bash", "-c", "python3 -u reviewer.py"]);
  });

  test("carries every required flag as an exact contiguous triple, not just a member somewhere", () => {
    expect(exactAt(argv, "--unshare-all")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--share-net")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--die-with-parent")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--new-session")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--cap-drop", "ALL")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--proc", "/proc")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--dev", "/dev")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--tmpfs", "/tmp")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--tmpfs", "/home/orbit")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--chdir", "/home/orbit/.config/agentglass/plugins/orbit-plugin")).toBeGreaterThanOrEqual(0);
  });

  test("never --clearenv: env reaches the box only through Bun.spawn's own hand-built env", () => {
    expect(argv).not.toContain("--clearenv");
  });

  test("HOME is the tmpfs, not a bind of the real home, and comes before every bind under it", () => {
    const homeTmpfs = exactAt(argv, "--tmpfs", "/home/orbit");
    expect(homeTmpfs).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind", "/home/orbit", "/home/orbit")).toBe(-1);
    expect(exactAt(argv, "--bind", "/home/orbit", "/home/orbit")).toBe(-1);
    // Everything this fixture binds under home — install dir, data dir, both
    // grants, the program dir — must come AFTER the tmpfs that makes home
    // empty, or bwrap would apply them in the wrong order and lose them.
    const underHome = [
      exactAt(argv, "--ro-bind", "/home/orbit/.config/agentglass/plugins/orbit-plugin", "/home/orbit/.config/agentglass/plugins/orbit-plugin"),
      exactAt(argv, "--bind", "/home/orbit/.config/agentglass/plugin-data/orbit-plugin", "/home/orbit/.config/agentglass/plugin-data/orbit-plugin"),
      exactAt(argv, "--ro-bind-fd", "3", "/home/orbit/.config/orbit-data"),
      exactAt(argv, "--bind-fd", "4", "/home/orbit/.local/share/orbit-plugin"),
      exactAt(argv, "--ro-bind", "/home/orbit/.volta/bin", "/home/orbit/.volta/bin"),
    ];
    for (const i of underHome) {
      expect(i).toBeGreaterThan(homeTmpfs);
    }
  });

  test("sets AGENTGLASS_PLUGIN_DATA, and binds the data dir read-write", () => {
    expect(exactAt(argv, "--setenv", "AGENTGLASS_PLUGIN_DATA", "/home/orbit/.config/agentglass/plugin-data/orbit-plugin")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--bind", "/home/orbit/.config/agentglass/plugin-data/orbit-plugin", "/home/orbit/.config/agentglass/plugin-data/orbit-plugin")).toBeGreaterThanOrEqual(0);
  });

  test("binds /usr, the install dir, program dirs, and system dirs/links", () => {
    expect(exactAt(argv, "--ro-bind", "/usr", "/usr")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind", "/home/orbit/.config/agentglass/plugins/orbit-plugin", "/home/orbit/.config/agentglass/plugins/orbit-plugin")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind", "/home/orbit/.volta/bin", "/home/orbit/.volta/bin")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind-try", "/etc", "/etc")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind-try", "/opt", "/opt")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--symlink", "usr/bin", "/bin")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve")).toBeGreaterThanOrEqual(0);
  });

  test("grants are handed as open descriptors, never as a path bwrap would resolve itself", () => {
    expect(exactAt(argv, "--ro-bind-fd", "3", "/home/orbit/.config/orbit-data")).toBeGreaterThanOrEqual(0);
    expect(exactAt(argv, "--bind-fd", "4", "/home/orbit/.local/share/orbit-plugin")).toBeGreaterThanOrEqual(0);
    expect(joined).not.toContain("--ro-bind /home/orbit/.config/orbit-data");
    expect(joined).not.toContain("--bind /home/orbit/.local/share/orbit-plugin");
  });

  test("never mounts anything under /run/user", () => {
    expect(joined).not.toContain("/run/user");
  });

  test("PATH drops entries under home and appends programDirs", () => {
    const i = argv.indexOf("PATH");
    expect(argv[i - 1]).toBe("--setenv");
    const path = argv[i + 1]!.split(":");
    expect(path).not.toContain("/home/orbit/.local/bin");
    expect(path).toEqual(expect.arrayContaining(["/usr/local/bin", "/usr/bin", "/home/orbit/.volta/bin"]));
  });

  test("no token anywhere in argv — SandboxEnv does not even have the field, and exactly four --setenv triples exist", () => {
    expect(joined).not.toContain("TOKEN");
    const setenvCount = argv.filter((a) => a === "--setenv").length;
    expect(setenvCount).toBe(4); // PATH, HOME, AGENTGLASS_URL, AGENTGLASS_PLUGIN_DATA
  });

  test("internet: no bridge, whatever the entrypoint is — the box's own command is the whole tail", () => {
    expect(joined).not.toContain("plugin-bridge");
    expect(joined).not.toContain(PLUGIN_SOCKET_BOX_PATH);
  });
});

describe("sandboxArgv, network: agentglass", () => {
  const network = { socketHostPath: "/home/orbit/.config/agentglass/plugin-runtime/plugin.sock", bridgeExec: ["/usr/bin/agentglass-server"], bridgeRo: ["/usr/bin/agentglass-server"] };
  // extraRo: [] on purpose, not the default fixture value — a networked box
  // is what plugins.ts' `buildBoxArgv` actually calls `hostResolvConfExtraRo`
  // for zero paths on (a DNS-exfiltration box: see the fixture below and
  // `boxExtraRo`), so a fixture that fed it "/run/systemd/resolve" here
  // would exempt the exact path the bug mounted and never go red.
  const argv = sandboxArgv(baseInput({ sandbox: NO_SANDBOX, network, extraRo: [] }));
  const joined = argv.join(" ");

  test("--unshare-net, never --share-net", () => {
    expect(exactAt(argv, "--unshare-net")).toBeGreaterThanOrEqual(0);
    expect(argv).not.toContain("--share-net");
  });

  test("the shared plugin socket is bind-mounted at the fixed box path, and the network split adds nothing else under /run — no /run/systemd/resolve, no resolver of any kind", () => {
    expect(exactAt(argv, "--ro-bind", network.socketHostPath, PLUGIN_SOCKET_BOX_PATH)).toBeGreaterThanOrEqual(0);
    // Never the writable form for this one: connect() needs nothing more,
    // and rw let the plugin chmod the host's own socket inode.
    expect(exactAt(argv, "--bind", network.socketHostPath, PLUGIN_SOCKET_BOX_PATH)).toBe(-1);
    const runMentions = argv.filter((a) => a.startsWith("/run") && a !== PLUGIN_SOCKET_BOX_PATH);
    expect(runMentions).toEqual([]);
    expect(joined).not.toContain("resolve");
  });

  test("the bridge's own files are bound after the tmpfs over HOME and /tmp, or they are hidden by it", () => {
    // Measured: the installed sidecar lives under HOME and an AppImage runs from /tmp; bound before the tmpfs, `bwrap: execvp` found nothing.
    const under = sandboxArgv(baseInput({ sandbox: NO_SANDBOX, network: { ...network, bridgeExec: ["/home/orbit/app/agentglass-server"], bridgeRo: ["/home/orbit/app/agentglass-server"] } }));
    const bind = exactAt(under, "--ro-bind", "/home/orbit/app/agentglass-server", "/home/orbit/app/agentglass-server");
    expect(bind).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(under.lastIndexOf("--tmpfs"));
    expect(under.join(" ")).not.toContain("--ro-bind-try /home/orbit/app");
  });

  test("the entrypoint is wrapped in the bridge, dialling the same box path over the URL's own port", () => {
    expect(argv.slice(-10)).toEqual([
      "/usr/bin/agentglass-server", "plugin-bridge", "--listen", "127.0.0.1:4000", "--socket", PLUGIN_SOCKET_BOX_PATH, "--", "bash", "-c", "python3 -u reviewer.py",
    ]);
  });

  test("without a `network` input, sandboxArgv refuses rather than silently running unwrapped", () => {
    expect(() => sandboxArgv(baseInput({ sandbox: NO_SANDBOX, network: undefined }))).toThrow();
  });
});

describe("hostSystemPaths / hostResolvConfExtraRo", () => {
  test("splits real directories from merged-usr symlinks, both from the same host this test runs on", () => {
    const { systemDirs, systemLinks } = hostSystemPaths();
    // Whatever this host looks like, every entry is one or the other, never both.
    const names = new Set([...systemDirs, ...systemLinks.map((l) => l.path)]);
    expect(names.size).toBe(systemDirs.length + systemLinks.length);
  });

  test("resolv.conf extra-ro is either empty or exactly /run/systemd/resolve, never /run or /run/user", () => {
    const extra = hostResolvConfExtraRo();
    for (const p of extra) {
      expect(p).toBe("/run/systemd/resolve");
    }
  });
});

describe("boxExtraRo — the exported decision buildBoxArgv actually ships", () => {
  // Nothing here goes through a fixture's own `extraRo` value: buildBoxArgv
  // itself boots a real plugin socket and is not something a unit test can
  // call, which is exactly how a reverted version of this one line (every
  // box, networked or not, got the host resolver mounted) shipped once with
  // every other test in this file still green. This calls the same function
  // production does, so reverting it fails HERE.
  test("no network (undefined): the real host resolver, whatever this host has", () => {
    expect(boxExtraRo(undefined)).toEqual(hostResolvConfExtraRo());
  });

  test("a network object of any shape: no resolver at all — the box has no interface to need one on", () => {
    expect(boxExtraRo({ socketHostPath: "/x", bridgeExec: [], bridgeRo: [] })).toEqual([]);
  });
});

describe("resolveGrants", () => {
  test("a plain grant under home is accepted and resolved", () => {
    const home = scratch("agx-sbx-home-");
    mkdirSync(join(home, ".config", "orbit-data"), { recursive: true });
    const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/.config/orbit-data"] };
    const r = resolveGrants(sandbox, home);
    expect(r.refused).toEqual([]);
    expect(r.read).toEqual([{ path: join(home, ".config", "orbit-data") }]);
  });

  test("a missing path is dropped, not refused", () => {
    const home = scratch("agx-sbx-home-");
    const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/.config/never-created"] };
    const r = resolveGrants(sandbox, home);
    expect(r.read).toEqual([]);
    expect(r.refused).toEqual([{ path: "~/.config/never-created", why: "does not exist" }]);
  });

  test("a symlink that resolves into .ssh is refused even though the spelling looked ordinary", () => {
    const home = scratch("agx-sbx-home-");
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".ssh", "id_x"), "fixture-secret");
    mkdirSync(join(home, ".config"), { recursive: true });
    symlinkSync(join(home, ".ssh"), join(home, ".config", "orbit"), "dir");
    const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/.config/orbit"] };
    const r = resolveGrants(sandbox, home);
    expect(r.read).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.path).toBe("~/.config/orbit");
    expect(r.refused[0]!.why).toContain("~/.ssh");
  });

  test("a grant that resolves to home itself, or to /, is refused", () => {
    const home = scratch("agx-sbx-home-");
    mkdirSync(join(home, "everything"), { recursive: true });
    symlinkSync(home, join(home, "everything", "back-to-home"), "dir");
    const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/everything/back-to-home"] };
    const r = resolveGrants(sandbox, home);
    expect(r.read).toEqual([]);
    expect(r.refused[0]!.why).toContain("whole home");
  });

  test("a grant of the live tmux socket directory is refused — a read-only bind still lets a plugin connect() through it", () => {
    const home = scratch("agx-sbx-home-");
    const savedTmux = process.env.TMUX_TMPDIR;
    const tmuxDir = scratch("agx-sbx-tmux-sock-");
    process.env.TMUX_TMPDIR = tmuxDir;
    try {
      mkdirSync(join(home, "link-to-sockets"), { recursive: true, mode: 0o700 });
      rmSync(join(home, "link-to-sockets"), { recursive: true, force: true });
      symlinkSync(tmuxDir, join(home, "link-to-sockets"), "dir");
      const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/link-to-sockets"] };
      const r = resolveGrants(sandbox, home);
      expect(r.read).toEqual([]);
      expect(r.refused[0]!.why).toMatch(/no plugin can be given/);
    } finally {
      if (savedTmux === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmux;
    }
  });

  test("a grant that resolves under /tmp is refused, whatever it is spelled as", () => {
    const home = scratch("agx-sbx-home-");
    const tmpTarget = scratch("agx-sbx-tmp-target-");
    symlinkSync(tmpTarget, join(home, "points-at-tmp"), "dir");
    const sandbox: PluginSandbox = { ...NO_SANDBOX, read: ["~/points-at-tmp"] };
    const r = resolveGrants(sandbox, home);
    expect(r.read).toEqual([]);
    expect(r.refused[0]!.why).toContain("/tmp");
  });

  test("write of a shell rc file, or of ~/.local/bin, is refused — read of the same path is fine", () => {
    const home = scratch("agx-sbx-home-");
    writeFileSync(join(home, ".bashrc"), "# fixture\n");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const sandbox: PluginSandbox = { ...NO_SANDBOX, write: ["~/.bashrc", "~/.local/bin"], read: ["~/.bashrc"] };
    const r = resolveGrants(sandbox, home);
    expect(r.write).toEqual([]);
    expect(r.refused).toHaveLength(2);
    expect(r.read).toEqual([{ path: join(home, ".bashrc") }]);
  });
});

describe("resolvePrograms", () => {
  test("a program outside home is not returned — /usr already covers it", () => {
    const home = scratch("agx-sbx-home-");
    const r = resolvePrograms(["true"], process.env.PATH ?? "", home);
    expect(r.dirs).toEqual([]);
    expect(r.refused).toEqual([]);
  });

  test("a program under home is returned, deduped against its own realpath", () => {
    const home = scratch("agx-sbx-home-");
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "orbit-cli"), "#!/bin/sh\necho hi\n");
    chmodSync(join(binDir, "orbit-cli"), 0o755);
    const r = resolvePrograms(["orbit-cli"], `${binDir}:${process.env.PATH ?? ""}`, home);
    expect(r.dirs).toEqual([binDir]);
  });

  // A version manager's `latest` is a symlink to the version dir, and PATH
  // names it. bwrap cannot mount onto a symlink destination ("Can't mount on
  // symlink destination …", exit 1 in the first milliseconds), so the mount
  // is the directory the link points at.
  test("a program reached through a symlinked directory is mounted at the real directory", () => {
    const home = scratch("agx-sbx-home-");
    const versions = join(home, ".local", "share", "orbit-mgr", "installs", "orbit-cli");
    mkdirSync(join(versions, "1.0.0"), { recursive: true });
    symlinkSync("./1.0.0", join(versions, "latest"));
    writeFileSync(join(versions, "1.0.0", "orbit-cli"), "#!/bin/sh\necho hi\n");
    chmodSync(join(versions, "1.0.0", "orbit-cli"), 0o755);
    const r = resolvePrograms(["orbit-cli"], `${join(versions, "latest")}:${process.env.PATH ?? ""}`, home);
    expect(r.dirs).toEqual([join(versions, "1.0.0")]);
  });

  test("an unknown command is silently skipped, not refused", () => {
    const home = scratch("agx-sbx-home-");
    const r = resolvePrograms(["not-a-real-command-xyz"], process.env.PATH ?? "", home);
    expect(r.dirs).toEqual([]);
    expect(r.refused).toEqual([]);
  });
});

describe("sandboxProbe", () => {
  test("bwrap missing entirely: reason is missing, forced by an empty PATH so this host's own bwrap cannot be found", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    __resetSandboxProbe();
    try {
      const probe = sandboxProbe();
      expect(probe).toEqual({ ok: false, reason: "missing", detail: "bwrap is not on PATH" });
    } finally {
      process.env.PATH = savedPath;
      __resetSandboxProbe();
    }
  });

  test("AGENTGLASS_BWRAP is ignored outside NODE_ENV=test — a stub that would always fail must not override the app's real bwrap", () => {
    const savedEnv = process.env.NODE_ENV;
    const savedBwrap = process.env.AGENTGLASS_BWRAP;
    const dir = scratch("agx-sbx-prod-stub-");
    const stub = join(dir, "bwrap");
    writeFileSync(stub, "#!/bin/sh\necho 'stub: should never run' >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    process.env.AGENTGLASS_BWRAP = stub;
    process.env.NODE_ENV = "production";
    __resetSandboxProbe();
    try {
      const probe = sandboxProbe();
      // Whatever this host actually has (bwrap present and working, or not
      // at all), it is never the always-failing stub this test pointed at —
      // the one thing this assertion needs is that the detail never names it.
      expect(JSON.stringify(probe)).not.toContain(stub);
    } finally {
      process.env.NODE_ENV = savedEnv;
      if (savedBwrap === undefined) delete process.env.AGENTGLASS_BWRAP; else process.env.AGENTGLASS_BWRAP = savedBwrap;
      __resetSandboxProbe();
    }
  });

  test("a stub bwrap that exits 1 fails, or reads userns-blocked when the sysctl says so — either way it is never ok", () => {
    const dir = scratch("agx-sbx-stub-");
    const stub = join(dir, "bwrap");
    writeFileSync(stub, "#!/bin/sh\necho 'stub: refused' >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    process.env.AGENTGLASS_BWRAP = stub;

    process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL = join(dir, "sysctl-0");
    writeFileSync(join(dir, "sysctl-0"), "0\n");
    __resetSandboxProbe();
    const notBlocked = sandboxProbe();
    expect(notBlocked).toEqual({ ok: false, reason: "failed", detail: "stub: refused" });

    process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL = join(dir, "sysctl-1");
    writeFileSync(join(dir, "sysctl-1"), "1\n");
    __resetSandboxProbe();
    const blocked = sandboxProbe();
    expect(blocked).toEqual({ ok: false, reason: "userns-blocked", detail: "stub: refused" });
  });

  test("a bwrap found on PATH but not at a trusted system location is refused, not trusted", () => {
    const dir = scratch("agx-sbx-untrusted-bwrap-");
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    const savedPath = process.env.PATH;
    const savedBwrap = process.env.AGENTGLASS_BWRAP;
    delete process.env.AGENTGLASS_BWRAP; // the test override is the one path this check must NOT apply to
    process.env.PATH = `${dir}:${savedPath}`;
    __resetSandboxProbe();
    try {
      const probe = sandboxProbe();
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.reason).toBe("missing");
        expect(probe.detail).toContain("not");
      }
    } finally {
      process.env.PATH = savedPath;
      if (savedBwrap === undefined) delete process.env.AGENTGLASS_BWRAP; else process.env.AGENTGLASS_BWRAP = savedBwrap;
      __resetSandboxProbe();
    }
  });

  test("cached for the process until reset", () => {
    process.env.AGENTGLASS_BWRAP = "/does/not/exist/bwrap";
    __resetSandboxProbe();
    const first = sandboxProbe();
    process.env.AGENTGLASS_BWRAP = "/usr/bin/bwrap";
    expect(sandboxProbe()).toEqual(first); // no reset: still the stale answer
    __resetSandboxProbe();
    expect(sandboxProbe()).not.toEqual(first);
  });
});

describe("pluginDataDir", () => {
  test("a sibling of the plugins install root, created on first ask", () => {
    const cfg = scratch("agx-sbx-cfg-");
    process.env.XDG_CONFIG_HOME = cfg;
    const dir = pluginDataDir("orbit-plugin");
    expect(dir).toBe(join(cfg, "agentglass", "plugin-data", "orbit-plugin"));
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe("ensurePluginSocketServer refuses to steal a live socket", () => {
  afterEach(() => stopPluginSocketServer());

  test("a stale file at the socket path (crashed process, no listener) is removed and bound fresh", async () => {
    const cfg = scratch("agx-sbx-stale-sock-");
    process.env.XDG_CONFIG_HOME = cfg;
    const path = pluginSocketPath();
    writeFileSync(path, ""); // a plain file, the shape a killed process leaves behind — nothing listening
    await ensurePluginSocketServer();
    // If the stale file had NOT been cleared, `Bun.serve({ unix: path })`
    // above would have thrown (EADDRINUSE on the leftover inode) rather
    // than silently succeeding, so reaching here already proves it bound.
    const r = await fetch("http://placeholder/plugin/self", { unix: path } as any);
    expect(r.status).toBe(401); // no token: the real gate answered, not a 404 from nothing home
  });

  test("a live server already at the socket path is left alone, not stolen", async () => {
    const cfg = scratch("agx-sbx-live-sock-");
    process.env.XDG_CONFIG_HOME = cfg;
    const path = pluginSocketPath();
    // Stands in for a second agentglass instance under the same config dir:
    // a real listener already answering at the fixed path, before this
    // process's own `ensurePluginSocketServer` ever runs.
    const other = Bun.serve({ unix: path, fetch: () => new Response("other instance") });
    try {
      await expect(ensurePluginSocketServer()).rejects.toThrow(/already live/);
      // The other instance's listener is untouched: same answer, same file.
      const r = await fetch("http://placeholder/anything", { unix: path } as any);
      expect(await r.text()).toBe("other instance");
    } finally {
      other.stop(true);
    }
  });

  test("concurrent calls over a stale socket share one attempt, not one each", async () => {
    const cfg = scratch("agx-sbx-concurrent-sock-");
    process.env.XDG_CONFIG_HOME = cfg;
    const path = pluginSocketPath();
    writeFileSync(path, ""); // stale: the post-crash shape both callers race to clear
    // Three enables (or an enable racing the boot resume) landing before the
    // first `ensurePluginSocketServer` settles used to each run their own
    // `rmSync` + `Bun.serve`, unlinking one another's fresh socket. Memoised,
    // every call made before the in-flight attempt settles gets the exact
    // same promise back — reference equality, not just "both eventually
    // resolve" — which is only true if a single attempt ran.
    const first = ensurePluginSocketServer();
    const second = ensurePluginSocketServer();
    const third = ensurePluginSocketServer();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await Promise.all([first, second, third]);
    const r = await fetch("http://placeholder/plugin/self", { unix: path } as any);
    expect(r.status).toBe(401); // the real gate answered: exactly one bind succeeded
  });
});

/** Opens `grants` and lays them onto `sandboxArgv` + `Bun.spawnSync`'s
 *  `stdio`, exactly the way `plugins.ts`' `buildBoxArgv`/`startProcess` do —
 *  the real-box tests below go through this rather than the bare argv
 *  builder, so a regression in the fd-wiring itself would show up here too. */
function runBoxed(opts: {
  bwrap: string; installDir: string; dataDir: string; home: string; entrypoint: string;
  sandbox: PluginSandbox; systemDirs: string[]; systemLinks: { path: string; target: string }[]; extraRo: string[];
  network?: { socketHostPath: string; bridgeExec: string[]; bridgeRo: string[] };
  breakHomeTmpfs?: boolean;
}): { exitCode: number; stdout: string; stderr: string } {
  const grants = resolveGrants(opts.sandbox, opts.home);
  const opened = openGrantFds({ read: grants.read, write: grants.write }, opts.home);
  let argv = sandboxArgv({
    bwrap: opts.bwrap,
    installDir: opts.installDir,
    dataDir: opts.dataDir,
    home: opts.home,
    entrypoint: opts.entrypoint,
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_URL: "http://127.0.0.1:4000" },
    sandbox: opts.sandbox,
    grants: { read: opened.read, write: opened.write },
    programDirs: [],
    systemLinks: opts.systemLinks,
    systemDirs: opts.systemDirs,
    extraRo: opts.extraRo,
    network: opts.network,
  });
  if (opts.breakHomeTmpfs) {
    const i = exactAt(argv, "--tmpfs", opts.home);
    expect(i).toBeGreaterThanOrEqual(0);
    argv = [...argv.slice(0, i), ...argv.slice(i + 2)]; // "--tmpfs" <home>: a pair, not a triple
  }
  try {
    const result = Bun.spawnSync(argv, { stdio: ["ignore", "pipe", "pipe", ...opened.parentFds] });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ? result.stdout.toString("utf8") : "",
      stderr: result.stderr ? result.stderr.toString("utf8") : "",
    };
  } finally {
    for (const fd of opened.parentFds) { try { closeSync(fd); } catch { /* fine */ } }
  }
}

describe("a real box, only on a host that can build one", () => {
  // Collection-time, not inside a hook: `test.skip` has to be chosen before
  // the test list is built. Reset first — nothing upstream in this file has
  // run a test body yet, but nothing should rely on that being true forever.
  delete process.env.AGENTGLASS_BWRAP;
  delete process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL;
  __resetSandboxProbe();
  const probe = sandboxProbe();
  const maybe = probe.ok ? test : test.skip;
  if (!probe.ok) console.warn(`box tests skipped: ${probe.reason}: ${probe.detail}`);

  maybe("keeps a secret off the plugin, keeps /run/user absent, keeps the host untouched, and still lets the plugin read its grant and write its data", () => {
    if (!probe.ok) return;
    // Outside /tmp, and installDir/dataDir under home as in production —
    // `--tmpfs /tmp` alone must not be why this test passes.
    const home = scratchOutsideTmp("agx-sbx-real-home-");
    mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".ssh", "id_x"), "fixture-secret");
    mkdirSync(join(home, ".config", "orbit-grant"), { recursive: true });
    writeFileSync(join(home, ".config", "orbit-grant", "data.txt"), "granted-content");
    const installDir = join(home, ".config", "agentglass", "plugins", "orbit-plugin");
    const dataDir = join(home, ".config", "agentglass", "plugin-data", "orbit-plugin");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // network: "internet" on purpose: this test is about the filesystem box
    // (HOME as tmpfs, the grant, /run/user), not the network split, and
    // pinning "internet" keeps it clear of the bridge slice 3 adds — that
    // gets its own describe block below.
    const sandbox: PluginSandbox = { network: "internet", read: ["~/.config/orbit-grant"], write: [], programs: [] };
    const { systemDirs, systemLinks } = hostSystemPaths();

    const entrypoint = [
      `cat ${home}/.ssh/id_x > "$AGENTGLASS_PLUGIN_DATA/secret" 2>"$AGENTGLASS_PLUGIN_DATA/secret.err"`,
      `ls /run/user > "$AGENTGLASS_PLUGIN_DATA/run-user" 2>&1`,
      `touch ${home}/escape 2>"$AGENTGLASS_PLUGIN_DATA/escape.err"`,
      `echo ok > "$AGENTGLASS_PLUGIN_DATA/write-ok"`,
      `cat ${join(home, ".config", "orbit-grant", "data.txt")} > "$AGENTGLASS_PLUGIN_DATA/grant-read" 2>"$AGENTGLASS_PLUGIN_DATA/grant-read.err"`,
    ].join("; ");

    const run = runBoxed({ bwrap: probe.bwrap, installDir, dataDir, home, entrypoint, sandbox, systemDirs, systemLinks, extraRo: hostResolvConfExtraRo() });
    if (run.exitCode !== 0) throw new Error(`box run failed (exit ${run.exitCode}): ${run.stderr}`);

    // The secret was never read: no such file inside the box (HOME is
    // tmpfs, .ssh was never mounted), so the redirected error, not the
    // fixture string, lands in the box's own data dir.
    const secret = readFileSync(join(dataDir, "secret"), "utf8");
    expect(secret).not.toContain("fixture-secret");

    expect(readFileSync(join(dataDir, "run-user"), "utf8")).toMatch(/No such file or directory|cannot access/);

    // The escape attempt failed inside the box (no such directory: HOME is
    // tmpfs) and, decisively, nothing landed on the real host's home.
    expect(existsSync(join(home, "escape"))).toBe(false);

    expect(readFileSync(join(dataDir, "write-ok"), "utf8").trim()).toBe("ok");
    expect(readFileSync(join(dataDir, "grant-read"), "utf8").trim()).toBe("granted-content");
  });

  maybe("without --tmpfs home, HOME does not exist inside the box at all — proving the flag is load-bearing, not decorative", () => {
    if (!probe.ok) return;
    // installDir/dataDir deliberately NOT under home and no grants declared:
    // nothing else in this argv would create HOME as a side effect (bwrap
    // auto-creates a bind target's own parent chain, which is exactly how
    // the primary test's installDir/dataDir stayed reachable above — this
    // one has no such bind anywhere near home, so `--tmpfs home` is the
    // only thing that could make the directory exist at all).
    const home = scratchOutsideTmp("agx-sbx-lonely-home-");
    const installDir = scratchOutsideTmp("agx-sbx-lonely-install-");
    const dataDir = scratchOutsideTmp("agx-sbx-lonely-data-");
    const { systemDirs, systemLinks } = hostSystemPaths();
    const entrypoint = `test -d "$HOME" && echo HOME_EXISTS || echo HOME_MISSING`;
    // network: "internet" — see the comment on the same choice above.
    const sandbox: PluginSandbox = { ...NO_SANDBOX, network: "internet" };

    const withTmpfs = runBoxed({ bwrap: probe.bwrap, installDir, dataDir, home, entrypoint, sandbox, systemDirs, systemLinks, extraRo: hostResolvConfExtraRo() });
    expect(withTmpfs.exitCode).toBe(0);
    expect(withTmpfs.stdout.trim()).toBe("HOME_EXISTS");

    const withoutTmpfs = runBoxed({
      bwrap: probe.bwrap, installDir, dataDir, home, entrypoint, sandbox, systemDirs, systemLinks,
      extraRo: hostResolvConfExtraRo(), breakHomeTmpfs: true,
    });
    expect(withoutTmpfs.exitCode).toBe(0);
    expect(withoutTmpfs.stdout.trim()).toBe("HOME_MISSING");
  });
});

describe("a real box, network: agentglass — only on a host that can build one", () => {
  delete process.env.AGENTGLASS_BWRAP;
  delete process.env.AGENTGLASS_SANDBOX_USERNS_SYSCTL;
  __resetSandboxProbe();
  const probe = sandboxProbe();
  const maybe = probe.ok ? test : test.skip;
  if (!probe.ok) console.warn(`network box tests skipped: ${probe.reason}: ${probe.detail}`);

  // This describe's own config dir, so its plugin socket does not land in
  // whatever `XDG_CONFIG_HOME` an earlier test in this file left behind.
  process.env.XDG_CONFIG_HOME = scratch("agx-sbx-netbox-cfg-");
  // This file's own listener, not the app's: `bun test` runs every file in
  // one process, so a stale singleton left running from here would answer
  // (with the wrong handler) whatever ANOTHER file's real-app boot expects
  // to have started fresh — see plugin-socket.test.ts, which boots a real
  // server that starts its own.
  afterAll(() => stopPluginSocketServer());

  const INDEX_TS = new URL("../src/index.ts", import.meta.url).pathname;

  /**
   * Runs the box with `Bun.spawn` (async), never `Bun.spawnSync`: the plugin
   * socket this test starts lives on THIS process's own event loop, and
   * `spawnSync` blocks that loop for the whole life of the child — measured
   * while writing this test, a curl inside the box timed out every time
   * against a `spawnSync`'d box, because the socket's own `fetch` callback
   * had no chance to run until the box (and the timeout) were already over.
   * `runBoxed` above gets away with `spawnSync` only because its own tests
   * never need this process to answer anything while the box runs.
   */
  async function runAgentglassBox(entrypoint: string): Promise<{ exitCode: number | null; dataDir: string }> {
    if (!probe.ok) throw new Error("runAgentglassBox called without a working bwrap");
    const { systemDirs, systemLinks } = hostSystemPaths();
    const home = scratchOutsideTmp("agx-sbx-netbox-home-");
    const installDir = join(home, "install");
    const dataDir = join(home, "data");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const network = { socketHostPath: pluginSocketPath(), bridgeExec: [process.execPath, INDEX_TS], bridgeRo: [process.execPath, join(INDEX_TS, "..", "..", "..")] };
    const argv = sandboxArgv({
      bwrap: probe.bwrap,
      installDir, dataDir, home, entrypoint,
      env: { PATH: "/usr/bin:/bin", AGENTGLASS_URL: `http://127.0.0.1:${await freePort()}` },
      sandbox: { network: "agentglass", read: [], write: [], programs: [] },
      grants: { read: [], write: [] },
      programDirs: [],
      systemLinks, systemDirs,
      // [] on purpose: this box has `network: "agentglass"` set, and
      // `buildBoxArgv` (plugins.ts) only asks `hostResolvConfExtraRo` for a
      // box with no network at all — see the DNS-exfiltration test below,
      // which is the reason this helper stopped hardcoding the host resolver in.
      extraRo: [],
      network,
    });
    const proc = Bun.spawn(argv, {
      env: { PATH: "/usr/bin:/bin", HOME: home, AGENTGLASS_READ_TOKEN: pluginToken },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await proc.exited;
    return { exitCode: proc.exitCode, dataDir };
  }

  let pluginToken: string;
  beforeEach(async () => {
    setPluginSocketHandler(async (req: Request) => {
      const url = new URL(req.url);
      return new Response(JSON.stringify({ ok: true, path: url.pathname }), { headers: { "content-type": "application/json" } });
    });
    if (probe.ok) await ensurePluginSocketServer();
    pluginToken = mintPluginToken("read", "orbit-net-plugin");
  });

  maybe("no internet, but the app is still reachable through the bridge", async () => {
    if (!probe.ok) return;
    const entrypoint = [
      `curl -sS -m 3 https://1.1.1.1 >/dev/null 2>"$AGENTGLASS_PLUGIN_DATA/internet.err"; echo $? > "$AGENTGLASS_PLUGIN_DATA/internet.exit"`,
      `curl -sS -m 3 "$AGENTGLASS_URL/plugin/self" -H "authorization: Bearer $AGENTGLASS_READ_TOKEN" > "$AGENTGLASS_PLUGIN_DATA/self.json" 2>"$AGENTGLASS_PLUGIN_DATA/self.err"; echo $? > "$AGENTGLASS_PLUGIN_DATA/self.exit"`,
    ].join("; ");
    const { dataDir } = await runAgentglassBox(entrypoint);
    expect(readFileSync(join(dataDir, "internet.exit"), "utf8").trim()).not.toBe("0");
    expect(readFileSync(join(dataDir, "self.exit"), "utf8").trim()).toBe("0");
    expect(JSON.parse(readFileSync(join(dataDir, "self.json"), "utf8"))).toEqual({ ok: true, path: "/plugin/self" });
  }, 15000);

  maybe("an abstract socket listener on the host is unreachable from the box — --unshare-net closes that namespace too", async () => {
    if (!probe.ok) return;
    // A `\0`-prefixed path is Linux's abstract namespace: no filesystem
    // entry, so nothing to bind-mount, and exactly the thing `--share-net`
    // would otherwise still hand a box for free (see the review note this
    // test answers, in the file header this slice's contract points at).
    const name = `agx-abstract-${process.pid}-${Date.now()}`;
    const abstractServer = Bun.listen({ unix: `\0${name}`, socket: { data() { /* never expected */ } } });
    try {
      const entrypoint = `python3 -c "
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(2)
try:
    s.connect('\\0${name}')
    open('$AGENTGLASS_PLUGIN_DATA/abstract', 'w').write('CONNECTED')
except OSError as e:
    open('$AGENTGLASS_PLUGIN_DATA/abstract', 'w').write('FAILED:' + str(e))
"`;
      const { dataDir } = await runAgentglassBox(entrypoint);
      expect(readFileSync(join(dataDir, "abstract"), "utf8")).toStartWith("FAILED");
    } finally {
      abstractServer.stop(true);
    }
  }, 15000);

  maybe("the host's resolve socket is not reachable from inside the box — no DNS-exfiltration side door", async () => {
    if (!probe.ok) return;
    if (!existsSync("/run/systemd/resolve/io.systemd.Resolve")) return; // nothing on this host to have leaked in the first place
    // `command not found` also matches the old, looser stderr regex here —
    // measured: a box with no `varlinkctl` on its PATH at all reported "bash:
    // varlinkctl: command not found", which contains "not found" and passed
    // this test vacuously, proving nothing about the mount. Checked on the
    // HOST (not inside the box: that's the box's own PATH, a different
    // question) so a host that cannot run this test at all says so rather
    // than passing empty.
    if (!Bun.which("varlinkctl")) {
      console.warn("DNS-exfiltration test skipped: no varlinkctl on this host's PATH");
      return;
    }
    // Before the fix, `hostResolvConfExtraRo()` was bind-mounted into every
    // box regardless of `network`, including this one — an
    // `--unshare-net` box with no interface at all, but a live varlink
    // socket that answers hostname lookups for the host's real resolver.
    // `varlinkctl` calling it directly (not a `getaddrinfo`/curl path,
    // which --unshare-net already blocks on its own) is the exact call
    // measured returning real addresses from inside an unpatched box. A
    // lookup that "succeeds" here is the regression this test exists to catch.
    const entrypoint = [
      `varlinkctl call /run/systemd/resolve/io.systemd.Resolve io.systemd.Resolve.ResolveHostname '{"name":"example.com"}' > "$AGENTGLASS_PLUGIN_DATA/resolve.out" 2> "$AGENTGLASS_PLUGIN_DATA/resolve.err"; echo $? > "$AGENTGLASS_PLUGIN_DATA/resolve.exit"`,
    ].join("; ");
    const { dataDir } = await runAgentglassBox(entrypoint);
    expect(readFileSync(join(dataDir, "resolve.exit"), "utf8").trim()).not.toBe("0");
    const stderr = readFileSync(join(dataDir, "resolve.err"), "utf8");
    // Both halves, not either: the failure has to be ABOUT the resolve
    // socket path specifically, not merely contain a phrase generic enough
    // for "command not found" to also match.
    expect(stderr).toContain("/run/systemd/resolve");
    expect(stderr).toMatch(/no such file|not found|does not exist/i);
  }, 15000);
});
