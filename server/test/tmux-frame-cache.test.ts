/*
 * The sweep's shared read, against a real tmux with a real attached client.
 *
 * `list-windows -a` answers the same thing for every client on a socket at
 * the same instant, so `readFrameCached` shares one spawn across all of them
 * instead of paying for one per attached pane. What has to hold: two calls on
 * the same socket within the TTL see the SAME (possibly stale) answer —
 * proven here by renaming a window between the two calls and checking the
 * second one still reports the old name — and a call past the TTL spawns
 * fresh and sees the rename.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { readFrameCached, type TmuxClient } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";

const SOCK = "agx-frame-cache";
const TMPDIR = `/tmp/agx-frame-cache-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const has = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

function clientOn(target: string, cols = 0, rows = 0): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,sys,time,fcntl,termios,struct\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0:\n" +
      "  if int(sys.argv[3]): fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[4]),int(sys.argv[3]),0,0))\n" +
      "  os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "time.sleep(600)\n",
      SOCK, target, String(cols), String(rows)],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } },
  );
}

let pty: ReturnType<typeof Bun.spawn> | null = null;
let wide: ReturnType<typeof Bun.spawn> | null = null;
let tty = "";

beforeAll(async () => {
  if (!has) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "cache", "-n", "one", "-x", "80", "-y", "24"]);
  pty = clientOn("cache");
  await Bun.sleep(1200);
  tty = out(["list-clients", "-F", "#{client_tty}"]).split("\n")[0] ?? "";
});

afterAll(() => {
  pty?.kill();
  wide?.kill();
  raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

const client = (): TmuxClient => ({ pid: 0, socket: ["-L", SOCK], tty });

describe("readFrameCached shares one spawn across a socket's clients", () => {
  if (!has) return;

  test("a second call within the TTL sees what the first one saw, not what changed after it", () => {
    const before = readFrameCached(client(), 5000)!;
    expect(before.windows.some((w) => w.name === "one")).toBe(true);

    raw(["rename-window", "-t", "cache:one", "renamed"]);

    // Same socket, well inside the TTL: this must not have spawned again, so
    // it still reports the name from before the rename.
    const stillCached = readFrameCached(client(), 5000)!;
    expect(stillCached.windows.some((w) => w.name === "one")).toBe(true);
    expect(stillCached.windows.some((w) => w.name === "renamed")).toBe(false);
  });

  test("a call past the TTL spawns fresh and sees the change", () => {
    // ttlMs: 0 never reuses a cached answer, whatever its age.
    const fresh = readFrameCached(client(), 0)!;
    expect(fresh.windows.some((w) => w.name === "renamed")).toBe(true);
  });

  test("parsed result is shared per session within TTL", () => {
    // Two calls from the same client within the TTL should reuse the parsed
    // result (windows/panes should be the same object reference).
    const frame1 = readFrameCached(client(), 5000)!;
    const frame2 = readFrameCached(client(), 5000)!;

    expect(frame1.target.session).toBe(frame2.target.session);
    expect(frame1.target.id).toBe(frame2.target.id);
    // Windows/panes should be identical object references (shared from cache)
    expect(frame1.windows).toBe(frame2.windows);
    expect(frame1.panes).toBe(frame2.panes);
  });
});

/*
 * The parse is shared per session, and some of what it holds is not the
 * session's. `client` is the size of ONE terminal — the one whose tty the call
 * named — and the desk compares it against the window to decide whether
 * somebody else is holding the window narrow. Two desks on one session at two
 * widths is ordinary (two app windows, a browser tab beside the desktop app),
 * and with the size cached per session the narrow one was handed the wide
 * one's width: "152 columns to your terminal's 174" on the terminal that was
 * itself 152 and driving the window. It alternated with whichever client
 * parsed first in each tick, which is why it flashed.
 */
describe("readFrameCached keeps each client's own fields", () => {
  if (!has) return;

  test("two clients on one session, inside one TTL, each get their own size", async () => {
    wide = clientOn("cache", 174, 47);
    let wideTty = "";
    for (let i = 0; i < 40 && !wideTty; i++) {
      await Bun.sleep(100);
      wideTty = out(["list-clients", "-F", "#{client_tty} #{client_width}"]).split("\n")
        .find((l) => l.endsWith(" 174"))?.split(" ")[0] ?? "";
    }
    expect(wideTty).not.toBe("");
    const narrowCols = Number(out(["list-clients", "-F", "#{client_tty} #{client_width}"]).split("\n")
      .find((l) => l.startsWith(`${tty} `))?.split(" ")[1]);
    expect(narrowCols).toBeGreaterThan(0);
    expect(narrowCols).not.toBe(174);

    // A TTL of 0 fetches a raw answer that has both clients in it; the two
    // calls after it share that answer and the parse the first one makes.
    const wideClient: TmuxClient = { pid: 0, socket: ["-L", SOCK], tty: wideTty };
    readFrameCached(wideClient, 0);
    const first = readFrameCached(wideClient, 5000)!;
    const second = readFrameCached(client(), 5000)!;
    expect(first.client?.cols).toBe(174);
    expect(second.client?.cols).toBe(narrowCols);
  }, 10_000);
});
