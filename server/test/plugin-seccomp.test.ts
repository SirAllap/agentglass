/*
 * The third wall around a boxed plugin: the seccomp filter from seccomp.ts,
 * handed to bwrap as `--seccomp FD` (see `seccompProbe` in plugin-sandbox.ts).
 *
 * Three claims, each against the thing that makes it true:
 *  - the program: run through a classic-BPF interpreter for every rule — a
 *    foreign arch is killed, the x32 bit is refused, each denied syscall is
 *    EPERM, clone keeps threads and loses namespaces, clone3 is ENOSYS;
 *  - the probe: no table for the arch, or a bwrap that rejects the flag,
 *    leaves the box running with the other walls and says why;
 *  - the box: a probe inside the real bwrap box gets EPERM from each denied
 *    syscall, the same calls without the filter do not, and ordinary work
 *    (files, threads, a child process, loopback TCP) still runs.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetSandboxProbe, __resetSeccompProbe, hostResolvConfExtraRo, hostSystemPaths, openSeccompFd, sandboxArgv, sandboxProbe, seccompNow, seccompProbe,
  type SandboxArgvInput,
} from "../src/plugin-sandbox.ts";
import { ARCHES, RET_ALLOW, RET_ENOSYS, RET_EPERM, RET_KILL_PROCESS, seccompProgram } from "../src/seccomp.ts";
import type { PluginSandbox } from "../../shared/pluginSandbox.ts";

const ORIGINAL = { arch: process.env.AGENTGLASS_SECCOMP_ARCH, bwrap: process.env.AGENTGLASS_BWRAP, xdg: process.env.XDG_CONFIG_HOME };
const root = mkdtempSync(join(tmpdir(), "agx-seccomp-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterAll(() => {
  restore("AGENTGLASS_SECCOMP_ARCH", ORIGINAL.arch);
  restore("AGENTGLASS_BWRAP", ORIGINAL.bwrap);
  restore("XDG_CONFIG_HOME", ORIGINAL.xdg);
  __resetSeccompProbe();
  __resetSandboxProbe();
  rmSync(root, { recursive: true, force: true });
});

/** Classic BPF as the kernel runs a seccomp filter: the opcodes seccomp.ts
 *  emits and nothing else, so an opcode it starts emitting fails here. */
function run(prog: Uint8Array, data: { nr: number; arch: number; args?: bigint[] }): number {
  const v = new DataView(prog.buffer, prog.byteOffset, prog.byteLength);
  const word = (off: number): number => {
    if (off === 0) return data.nr >>> 0;
    if (off === 4) return data.arch >>> 0;
    const i = (off - 16) >> 3;
    const a = data.args?.[i] ?? 0n;
    return Number(off % 8 === 0 ? a & 0xffffffffn : a >> 32n) >>> 0;
  };
  let acc = 0;
  for (let pc = 0; pc < prog.length / 8;) {
    const code = v.getUint16(pc * 8, true), jt = v.getUint8(pc * 8 + 2), jf = v.getUint8(pc * 8 + 3), k = v.getUint32(pc * 8 + 4, true);
    pc++;
    if (code === 0x20) acc = word(k);
    else if (code === 0x06) return k;
    else if (code === 0x15) pc += acc === k ? jt : jf;
    else if (code === 0x35) pc += acc >= k ? jt : jf;
    else if (code === 0x45) pc += (acc & k) !== 0 ? jt : jf;
    else throw new Error(`opcode ${code.toString(16)}`);
  }
  throw new Error("fell off the end");
}

for (const [arch, t] of Object.entries(ARCHES)) {
  describe(`the program for ${arch}`, () => {
    const prog = seccompProgram(arch)!;
    const call = (nr: number, ...args: bigint[]) => run(prog, { nr, arch: t.audit, args });
    const read = arch === "x64" ? 0 : 63;

    test("a foreign arch dies, whatever the number", () => {
      expect(run(prog, { nr: read, arch: 0x40000003 })).toBe(RET_KILL_PROCESS);
      expect(run(prog, { nr: t.deny.ptrace!, arch: 0x40000028 })).toBe(RET_KILL_PROCESS);
    });

    test("every denied syscall is EPERM; an ordinary one is allowed", () => {
      for (const [name, nr] of Object.entries(t.deny)) expect([name, call(nr)]).toEqual([name, RET_EPERM]);
      expect(call(read)).toBe(RET_ALLOW);
    });

    test.skipIf(!t.x32Bit)("the x32 bit is refused (the classic way past a deny list)", () => {
      expect(call(0x40000000 | t.deny.ptrace!)).toBe(RET_EPERM);
      expect(call(0x40000000 | read)).toBe(RET_EPERM);
    });

    test("clone: a thread and a fork pass, a new namespace does not; clone3 is ENOSYS so libc falls back to clone", () => {
      expect(call(t.clone, 0x3d0f00n)).toBe(RET_ALLOW); // pthread_create's flags
      expect(call(t.clone, 0x1200011n)).toBe(RET_ALLOW); // fork()'s
      expect(call(t.clone, 0x10000000n | 17n)).toBe(RET_EPERM); // CLONE_NEWUSER | SIGCHLD
      expect(call(t.clone, 0x40000000n)).toBe(RET_EPERM); // CLONE_NEWNET
      expect(call(t.clone3)).toBe(RET_ENOSYS);
    });

    test("ioctl: TIOCSTI and TIOCLINUX are refused on the low word; TCGETS passes", () => {
      expect(call(t.ioctl, 0n, 0x5412n)).toBe(RET_EPERM);
      expect(call(t.ioctl, 0n, 0x1_0000_5412n)).toBe(RET_EPERM);
      expect(call(t.ioctl, 0n, 0x541cn)).toBe(RET_EPERM);
      expect(call(t.ioctl, 0n, 0x5401n)).toBe(RET_ALLOW);
    });

    test("personality: asking and the default pass; ADDR_NO_RANDOMIZE does not", () => {
      expect(call(t.personality, 0xffffffffn)).toBe(RET_ALLOW);
      expect(call(t.personality, 0n)).toBe(RET_ALLOW);
      expect(call(t.personality, 0x0040000n)).toBe(RET_EPERM);
    });
  });
}

test("an arch with no table gets no program", () => {
  expect(seccompProgram("riscv64")).toBeNull();
});

const SANDBOX: PluginSandbox = { network: "internet", read: [], write: [], programs: [] };

function input(over: Partial<SandboxArgvInput> = {}): SandboxArgvInput {
  return {
    bwrap: "/usr/bin/bwrap", installDir: "/home/orbit/.config/agentglass/plugins/acme", dataDir: "/home/orbit/.config/agentglass/plugin-data/acme",
    home: "/home/orbit", entrypoint: "python3 -u reviewer.py", env: { PATH: "/usr/bin", AGENTGLASS_URL: "http://127.0.0.1:4000" },
    sandbox: SANDBOX, grants: { read: [], write: [] }, programDirs: [], systemLinks: [], systemDirs: ["/etc"], extraRo: [], ...over,
  };
}

describe("sandboxArgv with a filter", () => {
  test("--seccomp names the child fd, among bwrap's own flags", () => {
    const argv = sandboxArgv(input({ seccompFd: 6 }));
    const at = argv.indexOf("--seccomp");
    expect(argv[at + 1]).toBe("6");
    expect(at).toBeLessThan(argv.indexOf("--chdir"));
  });
  test("absent, the argv is exactly as before", () => {
    expect(sandboxArgv(input())).not.toContain("--seccomp");
  });
});

const pluginsSrc = await Bun.file(join(import.meta.dir, "..", "src", "plugins.ts")).text();
test("buildBoxArgv puts the filter's fd after the grants' and hands it over; the public probe reports it", () => {
  const at = pluginsSrc.indexOf("async function buildBoxArgv(");
  const body = pluginsSrc.slice(at, pluginsSrc.indexOf("\n}\n", at));
  expect(body).toContain("const seccompFd = seccompParentFd === null ? undefined : 3 + opened.parentFds.length;");
  expect(body.indexOf("3 + opened.parentFds.length")).toBeLessThan(body.indexOf("opened.parentFds.push(seccompParentFd)"));
  expect(body).toContain("seccompFd,");
  const pub = pluginsSrc.slice(pluginsSrc.indexOf("function publicProbe("));
  expect(pub.slice(0, pub.indexOf("\n}\n"))).toContain("seccomp: sc.ok")
  expect(pub.slice(0, pub.indexOf("\n}\n"))).toContain("seccompNow()");
});

__resetSandboxProbe();
const hostBox = sandboxProbe();

describe("seccompProbe falls back and says why", () => {
  beforeEach(() => {
    delete process.env.AGENTGLASS_SECCOMP_ARCH;
    delete process.env.AGENTGLASS_BWRAP;
    __resetSeccompProbe();
    __resetSandboxProbe();
  });

  test.skipIf(!hostBox.ok)("an arch with no table", () => {
    process.env.AGENTGLASS_SECCOMP_ARCH = "riscv64";
    const p = seccompProbe();
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.detail).toBe("there is no filter for this architecture (riscv64)");
  });

  test("a bwrap that builds a box but rejects --seccomp", () => {
    const stub = join(root, "bwrap-no-seccomp");
    writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do [ "$a" = --seccomp ] && { echo "bwrap: Unknown option --seccomp" >&2; exit 1; }; done\nexit 0\n');
    chmodSync(stub, 0o755);
    process.env.AGENTGLASS_BWRAP = stub;
    expect(sandboxProbe().ok).toBe(true);
    const p = seccompProbe();
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.detail).toBe("bwrap: Unknown option --seccomp");
  });

  test("no box at all", () => {
    process.env.AGENTGLASS_BWRAP = join(root, "missing-bwrap");
    const p = seccompProbe();
    expect(p.ok).toBe(false);
  });

  test.skipIf(!hostBox.ok)("this host: the box comes up filtered, and a rewritten file is not handed out", () => {
    const p = seccompProbe();
    expect(p).toMatchObject({ ok: true });
    if (!p.ok) return;
    const fd = openSeccompFd(p);
    expect(fd).not.toBeNull();
    closeSync(fd!);
    writeFileSync(p.path, new Uint8Array(p.program.length));
    expect(openSeccompFd(p)).toBeNull();
  });

  test.skipIf(!hostBox.ok)("two instances sharing a config dir do not touch each other's filter; the panel follows a vanished file", () => {
    const a = seccompProbe();
    __resetSeccompProbe();
    const b = seccompProbe();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.path).not.toBe(b.path);
    const fd = openSeccompFd(a);
    expect(fd).not.toBeNull();
    closeSync(fd!);
    expect(statSync(b.path).mode & 0o777).toBe(0o600);
    expect(seccompNow()).toMatchObject({ ok: true });
    rmSync(b.path);
    const gone = seccompNow();
    expect(gone.ok).toBe(false);
    expect(openSeccompFd(b)).toBeNull();
  });
});

__resetSeccompProbe();
__resetSandboxProbe();
const hostFilter = hostBox.ok ? seccompProbe() : null;

/** One line per call, `name errno` (0 = it ran). */
const PROBE = String.raw`
import ctypes, os, socket, subprocess, sys, threading
libc = ctypes.CDLL(None, use_errno=True)
def sc(name, nr, *args):
    ctypes.set_errno(0)
    r = libc.syscall(ctypes.c_long(nr), *[ctypes.c_long(a) for a in args])
    if r == 0 and name == "clone": os._exit(0)
    print(name, ctypes.get_errno() if r == -1 else 0, flush=True)
N = dict(arg.split("=") for arg in sys.argv[1].split(","))
for name in sys.argv[2].split(","):
    nr = int(N[name])
    if name == "unshare": sc(name, nr, 0x10000000)
    elif name == "ptrace": sc(name, nr, 3, 1, 0, 0)
    elif name == "personality": sc(name, nr, 0x0040000)
    elif name == "clone": sc(name, nr, 0x10000000 | 17, 0, 0, 0, 0)
    elif name == "ioctl_tiocsti": sc(name, nr, 0, 0x5412, 0)
    elif name == "ioctl_tiocsti_high": sc(name, nr, 0, 0x100005412, 0)
    elif name == "x32": sc(name, nr | 0x40000000)
    elif name == "process_vm_readv": sc(name, nr, os.getpid(), 0, 0, 0, 0, 0)
    else: sc(name, nr, 0, 0, 0, 0, 0)
t = threading.Thread(target=lambda: print("thread ran", flush=True)); t.start(); t.join()
print("child", subprocess.run(["sh", "-c", "echo out"], capture_output=True, text=True).stdout.strip(), flush=True)
open(os.environ["AGENTGLASS_PLUGIN_DATA"] + "/state", "w").write("kept")
print("data", open(os.environ["AGENTGLASS_PLUGIN_DATA"] + "/state").read(), flush=True)
print("tcp", socket.create_connection(("127.0.0.1", int(sys.argv[3]))).recv(8), flush=True)
`;

// Gated on the box and the arch, never on the probe under test: a probe that
// breaks must turn this red, not skip it.
describe.skipIf(!hostBox.ok || !ARCHES[process.arch])("inside the real box", () => {
  const t = ARCHES[process.arch]!;
  test("the probe works here", () => { expect(hostFilter).toMatchObject({ ok: true }); });
  const b = join(root, "box");
  const home = join(b, "home");
  for (const d of [home, join(b, "install"), join(b, "data")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(b, "install", "probe.py"), PROBE);
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sk) { sk.write("TCP"); sk.end(); }, data() {} } });
  afterAll(() => tcp.stop(true));
  // clone first: once unshare has put the probe in a user namespace with no
  // mapping, the kernel itself refuses a nested one and the comparison proves nothing.
  const numbers = { clone: t.clone, ...t.deny, clone3: t.clone3, ioctl_tiocsti: t.ioctl, ioctl_tiocsti_high: t.ioctl, personality: t.personality, ...(t.x32Bit ? { x32: 39 } : {}) };
  const names = Object.keys(numbers);

  async function box(filtered: boolean): Promise<Map<string, string>> {
    const probe = sandboxProbe();
    if (!probe.ok || !hostFilter?.ok) throw new Error("unreachable: skipped");
    // Probed again: the fallback tests above rewrite the same file.
    __resetSeccompProbe();
    const filter = seccompProbe();
    const fd = filtered && filter.ok ? openSeccompFd(filter) : null;
    if (filtered && fd === null) throw new Error("the filter could not be opened");
    const { systemDirs, systemLinks } = hostSystemPaths();
    const argv = sandboxArgv({
      ...input(), bwrap: probe.bwrap, installDir: join(b, "install"), dataDir: join(b, "data"), home, systemDirs, systemLinks, extraRo: hostResolvConfExtraRo(),
      env: { PATH: "/usr/bin:/bin", AGENTGLASS_URL: "http://127.0.0.1:4000" },
      entrypoint: `python3 -I probe.py ${Object.entries(numbers).map(([k, v]) => `${k}=${v}`).join(",")} ${names.join(",")} ${tcp.port}`,
      ...(fd === null ? {} : { seccompFd: 3 }),
    });
    const p = Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe", ...(fd === null ? [] : [fd])], env: { PATH: "/usr/bin:/bin", AGENTGLASS_PLUGIN_DATA: join(b, "data") } });
    if (fd !== null) closeSync(fd);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    const lines = new Map<string, string>();
    for (const l of out.split("\n")) { const i = l.indexOf(" "); if (i > 0) lines.set(l.slice(0, i), l.slice(i + 1)); }
    if (!lines.has("tcp")) throw new Error(`the probe did not finish:\n${out}\n${err}`);
    return lines;
  }

  test("every denied syscall is EPERM (clone3 ENOSYS), and ordinary work still runs", async () => {
    const r = await box(true);
    for (const n of names) expect([n, r.get(n)]).toEqual([n, n === "clone3" ? "38" : "1"]);
    expect(r.get("thread")).toBe("ran");
    expect(r.get("child")).toBe("out");
    expect(r.get("data")).toBe("kept");
    expect(r.get("tcp")).toBe("b'TCP'");
  });

  test("without the filter the same calls get other answers (the filter is what refuses them)", async () => {
    const r = await box(false);
    for (const n of ["unshare", "personality", "clone", "process_vm_readv", "ioctl_tiocsti", "ioctl_tiocsti_high", "clone3", "ptrace"]) {
      expect([n, r.get(n)]).not.toEqual([n, "1"]);
    }
    expect(r.get("tcp")).toBe("b'TCP'");
  });
});
