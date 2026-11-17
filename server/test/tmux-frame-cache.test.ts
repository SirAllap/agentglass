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
import { readFrameCached, readFrameFresh, type TmuxClient } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";
import { story } from "./story.ts";
import { agxTestBase } from "./tmuxTmp.ts";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();

const SOCK = "agx-frame-cache";
const TMPDIR = agxTestBase("agx-frame-cache");
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

const step = story();

/** A background refresh lands on its own; wait for `ok` rather than a fixed sleep. */
async function until(ok: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await Bun.sleep(25); }
  return ok();
}

describe("readFrameCached shares one spawn across a socket's clients", () => {
  if (!has) return;

  step("a cold cache answers null at once and the read lands in the background", async () => {
    const t = Date.now();
    expect(readFrameCached(client(), 5000)).toBeNull();
    // It must not have waited for tmux: a spawn on this thread is tens of ms at best.
    expect(Date.now() - t).toBeLessThan(15);
    expect(await until(() => readFrameCached(client(), 5000) !== null)).toBe(true);
    expect(readFrameCached(client(), 5000)!.windows.some((w) => w.name === "one")).toBe(true);
  });

  step("a second call within the TTL sees what the first one saw, not what changed after it", () => {
    raw(["rename-window", "-t", "cache:one", "renamed"]);
    const stillCached = readFrameCached(client(), 5000)!;
    expect(stillCached.windows.some((w) => w.name === "one")).toBe(true);
    expect(stillCached.windows.some((w) => w.name === "renamed")).toBe(false);
  });

  step("a call past the TTL answers the old frame at once, and the next one sees the change", async () => {
    // ttlMs: 0 is stale whatever its age: served from the cache, refreshed off the loop.
    const t = Date.now();
    const old = readFrameCached(client(), 0)!;
    expect(Date.now() - t).toBeLessThan(15);
    expect(old.windows.some((w) => w.name === "one")).toBe(true);
    expect(await until(() => readFrameCached(client(), 5000)!.windows.some((w) => w.name === "renamed"))).toBe(true);
  });

  step("many stale calls share one refresh per socket", async () => {
    let spawned = 0;
    const real = Bun.spawn;
    (Bun as any).spawn = (...a: any[]) => { if (JSON.stringify(a[0]).includes("list-windows")) spawned++; return (real as any)(...a); };
    try {
      for (let i = 0; i < 20; i++) readFrameCached(client(), 0);
      await Bun.sleep(600);
    } finally { (Bun as any).spawn = real; }
    expect(spawned).toBe(1);
  });

  step("parsed result is shared per session within TTL", () => {
    const frame1 = readFrameCached(client(), 5000)!;
    const frame2 = readFrameCached(client(), 5000)!;
    expect(frame1.target.session).toBe(frame2.target.session);
    expect(frame1.target.id).toBe(frame2.target.id);
    expect(frame1.windows).toBe(frame2.windows);
    expect(frame1.panes).toBe(frame2.panes);
  });

  step("readFrameFresh still reads tmux itself when the held read is stale", () => {
    raw(["rename-window", "-t", "cache:renamed", "one"]);
    expect(readFrameFresh(client(), 0)!.windows.some((w) => w.name === "one")).toBe(true);
    raw(["rename-window", "-t", "cache:one", "renamed"]);
    expect(readFrameFresh(client(), 5000)!.windows.some((w) => w.name === "one")).toBe(true);
  });

  /*
   * The tab strip learns about a window switch from the sweep armed off the
   * redraw the switch causes. That sweep shares this cache with the pane's own
   * poll and every other panel on the socket, so a read from just BEFORE the
   * switch is nearly always there and under the TTL — and the strip sat on the
   * old window until the next poll, up to two seconds later. `notBefore` says
   * "tmux changed at this moment": older reads are refused, and the fresh read
   * must not be handed the parse of the stale one either.
   */
  step("a read from before notBefore is never served, parse included, so a switch shows once it lands", async () => {
    raw(["new-window", "-d", "-t", "cache", "-n", "two", "sleep 600"]);
    await until(() => readFrameCached(client(), 0, Date.now()) !== null);
    const before = readFrameCached(client(), 5000)!;
    const was = before.windows.find((w) => w.active)!.name;
    const other = was === "two" ? "renamed" : "two";

    raw(["select-window", "-t", `cache:${other}`]);
    const switchedAt = Date.now();

    // Inside the TTL with no floor: still the old answer, which is the trap.
    expect(readFrameCached(client(), 5000)!.windows.find((w) => w.active)!.name).toBe(was);
    // With the moment of the switch as the floor: not the old one, not even stale.
    expect(readFrameCached(client(), 5000, switchedAt)).toBeNull();
    expect(await until(() => readFrameCached(client(), 5000, switchedAt) !== null)).toBe(true);
    expect(readFrameCached(client(), 5000, switchedAt)!.windows.find((w) => w.active)!.name).toBe(other);
    expect(readFrameCached(client(), 5000)!.windows.find((w) => w.active)!.name).toBe(other);
  });
});

/*
 * The two callers that know tmux just moved must say so. Source, because the
 * sweep lives inside ptyOpen with a real shell behind it.
 */
describe("the sweeps that follow a change refuse a read from before it", () => {
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  step("the redraw nudge passes the moment its burst began", () => {
    const start = src.indexOf("const nudgeTmux = () => {");
    expect(start).toBeGreaterThan(-1);
    const body = code(src.slice(start, src.indexOf("\n  };", start)));
    expect(body).toContain("sweep(from)");
    expect(body).not.toContain("sweep()");
  });

  step("a sweep asked for after an action passes the moment it was asked", () => {
    expect(code(src)).toContain("session.tmuxSweep = () => sweep(Date.now());");
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

  step("two clients on one session, inside one TTL, each get their own size", async () => {
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
    readFrameFresh(wideClient, 0);
    const first = readFrameCached(wideClient, 5000)!;
    const second = readFrameCached(client(), 5000)!;
    expect(first.client?.cols).toBe(174);
    expect(second.client?.cols).toBe(narrowCols);
  }, 10_000);
});
