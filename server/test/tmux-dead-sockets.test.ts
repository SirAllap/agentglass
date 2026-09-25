/**
 * A socket directory full of leftovers must not cost a tmux spawn per file.
 *
 * Every server that exits uncleanly leaves its socket file behind, and the
 * panes routes walked all of them with a blocking `tmux list-clients` each:
 * 127 dead files measured ~450ms of frozen event loop per poll. The fix asks
 * the kernel which of them anything listens on. These pin the parser, the
 * filter against a real live server beside a hundred dead files, and the
 * fallback used where /proc/net/unix cannot be read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  listeningUnixPaths, tmuxSockets, listPanes, __setProcNetUnixPath, NO_SERVER,
  __procNetUnixReadCount, __resetProcNetUnixReadCount,
} from "../src/tmuxctl.ts";

const FIXTURE = [
  "Num       RefCount Protocol Flags    Type St Inode Path",
  "00000000a81bbf83: 00000002 00000000 00010000 0001 01 84490256 /tmp/tmux-1000/orbit",
  "000000001587cd2f: 00000003 00000000 00000000 0001 03 46106 /run/systemd/journal/stdout",
  "00000000200d8373: 00000002 00000000 00010000 0001 01 21922143 /tmp/acme dir/tmux-1000/with space",
  "0000000073176de9: 00000002 00000000 00010000 0001 01 10680032 @/abstract/name",
  "00000000e2cd3af6: 00000002 00000000 00010000 0005 01 31183017",
  // %5lu pads an inode under 5 digits with spaces, not zeros: the extra runs
  // of whitespace before the inode field must not shift the path column.
  "00000000b7f1a204: 00000002 00000000 00010000 0001 01  7662 /tmp/tmux-1000/early",
  "",
].join("\n");

describe("listeningUnixPaths", () => {
  test("keeps listening rows with a filesystem path, and only those", () => {
    expect([...listeningUnixPaths(FIXTURE)].sort()).toEqual([
      "/tmp/acme dir/tmux-1000/with space",
      "/tmp/tmux-1000/early",
      "/tmp/tmux-1000/orbit",
    ]);
  });
});

const uid = process.getuid?.() ?? 0;
const LABEL = "agx-livecheck";
let tmpdir = "";
let sockDir = "";
const savedTmp = process.env.TMUX_TMPDIR;
const tmuxEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") env[k] = v;
  env.TMUX_TMPDIR = tmpdir;
  return env;
};
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", LABEL, ...args], { env: tmuxEnv(), stdout: "ignore", stderr: "ignore" });

describe("tmuxSockets against a hundred dead sockets", () => {
  beforeAll(() => {
    tmpdir = mkdtempSync("/tmp/agx-deadsock-");
    sockDir = join(tmpdir, `tmux-${uid}`);
    mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    const seeded = Bun.spawnSync(["python3", "-c", [
      "import socket, sys",
      "for i in range(100):",
      "    s = socket.socket(socket.AF_UNIX); s.bind(f'{sys.argv[1]}/agx-orbit-{i}'); s.close()",
    ].join("\n"), sockDir]);
    if (seeded.exitCode !== 0) throw new Error(seeded.stderr.toString());
    if (tmux("new-session", "-d", "sleep", "60").exitCode !== 0) throw new Error("could not start the live tmux");
    process.env.TMUX_TMPDIR = tmpdir;
  });

  afterAll(() => {
    __setProcNetUnixPath(null);
    tmux("kill-server");
    if (savedTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmp;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  test("answers only the live server, quickly", () => {
    const a = performance.now();
    const got = tmuxSockets();
    const took = performance.now() - a;
    expect(got).toEqual([["-S", join(sockDir, LABEL)]]);
    expect(took).toBeLessThan(50);
  });

  test("keeps the known socket even when nothing listens on it", () => {
    const known = ["-S", join(sockDir, "agx-orbit-7")];
    expect(tmuxSockets(known)).toEqual([known, ["-S", join(sockDir, LABEL)]]);
  });

  test("without /proc/net/unix, a socket tmux could not reach is skipped next time", async () => {
    __setProcNetUnixPath(join(tmpdir, "no-such-proc-file"));
    expect(tmuxSockets().length).toBe(101);
    // Asks every socket once; the dead ones answer "no server running". And it
    // does so without holding the loop: a timer keeps firing meanwhile, where
    // the blocking walk this replaced let none through until it was done.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 2);
    await listPanes();
    clearInterval(timer);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(tmuxSockets()).toEqual([["-S", join(sockDir, LABEL)]]);
  });
});

describe("NO_SERVER", () => {
  test("a busy live server's connect error is not classified as dead", () => {
    expect(NO_SERVER.test("error connecting to /tmp/tmux-1000/orbit (Resource temporarily unavailable)")).toBe(false);
  });
  test("a genuinely absent server is classified as dead", () => {
    expect(NO_SERVER.test("no server running on /tmp/tmux-1000/orbit")).toBe(true);
  });
});

describe("tmuxSockets / /proc/net/unix", () => {
  let memoRoot = "";
  const saved = process.env.TMUX_TMPDIR;

  beforeAll(() => { memoRoot = mkdtempSync("/tmp/agx-procmemo-"); });
  afterAll(() => {
    __setProcNetUnixPath(null);
    if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved;
    rmSync(memoRoot, { recursive: true, force: true });
  });

  test("an empty socket directory never reads /proc/net/unix", () => {
    const emptyRoot = join(memoRoot, "empty");
    mkdirSync(join(emptyRoot, `tmux-${uid}`), { recursive: true, mode: 0o700 });
    const procFile = join(memoRoot, "unreadable-if-touched");
    writeFileSync(procFile, "Num       RefCount Protocol Flags    Type St Inode Path\n");
    __setProcNetUnixPath(procFile);
    __resetProcNetUnixReadCount();
    process.env.TMUX_TMPDIR = emptyRoot;
    expect(tmuxSockets()).toEqual([]);
    expect(__procNetUnixReadCount).toBe(0);
  });

  test("two calls inside one second share one parse of /proc/net/unix", () => {
    const liveRoot = join(memoRoot, "live");
    const liveSockDir = join(liveRoot, `tmux-${uid}`);
    mkdirSync(liveSockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(liveSockDir, LABEL), "");
    const procFile = join(memoRoot, "unix-for-memo");
    writeFileSync(procFile, [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      `00000000a81bbf83: 00000002 00000000 00010000 0001 01 84490256 ${join(liveSockDir, LABEL)}`,
      "",
    ].join("\n"));
    __setProcNetUnixPath(procFile);
    __resetProcNetUnixReadCount();
    process.env.TMUX_TMPDIR = liveRoot;
    const a = tmuxSockets();
    const b = tmuxSockets();
    expect(__procNetUnixReadCount).toBe(1);
    expect(a).toEqual(b);
  });
});
