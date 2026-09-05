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

function clientOn(target: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "time.sleep(600)\n",
      SOCK, target],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } },
  );
}

let pty: ReturnType<typeof Bun.spawn> | null = null;
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
