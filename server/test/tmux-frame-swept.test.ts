/*
 * The sweep's read must not spawn tmux on the caller's path.
 *
 * A sweep ran a synchronous `tmux` per attached terminal per tick, plus one
 * `display-message` per phone mirror per desk: with thirty of each, a server
 * profile put a fifth of the main thread in spawnSync, and under memory
 * pressure every spawn took long enough to freeze every terminal. The sweep now
 * reads through `readFrameSwept`: the latest answer at once, a single-flight
 * async refresh per socket, the phones resolved once per refresh, and the
 * sweep run again when the refresh lands.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { readFrameFresh, readFrameSwept, type TmuxClient } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";
import { agxTestBase } from "./tmuxTmp.ts";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const ctl = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();

const SOCK = "agx-frame-swept";
const TMPDIR = agxTestBase("agx-frame-swept");
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
      "if pid==0:\n" +
      "  os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "time.sleep(600)\n",
      SOCK, target],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } },
  );
}

/** Poll a condition on the clock the test cares about, never a fixed sleep. */
async function settled(ok: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await Bun.sleep(25); }
  return ok();
}

let desk: ReturnType<typeof Bun.spawn> | null = null;
let phone: ReturnType<typeof Bun.spawn> | null = null;
let tty = "";
const client = (t = tty): TmuxClient => ({ pid: 0, socket: ["-L", SOCK], tty: t });
/** One call, resolved when its `onFresh` fires. */
const landed = (notBefore = 0, ttl = 450, t = tty) => {
  let fired = 0;
  const r = readFrameSwept(client(t), ttl, notBefore, () => { fired++; });
  return { r, fires: () => fired };
};

beforeAll(async () => {
  if (!has) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "desk", "-n", "one", "-x", "80", "-y", "24"]);
  desk = clientOn("desk");
  await settled(() => out(["list-clients", "-F", "#{client_tty}"]).length > 0);
  tty = out(["list-clients", "-F", "#{client_tty}"]).split("\n")[0] ?? "";
}, 20_000);

afterAll(() => {
  desk?.kill();
  phone?.kill();
  raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

describe("the sweep never spawns tmux itself", () => {
  test("the sweep body calls neither the sync frame read nor the sync phone walk", () => {
    const a = src.indexOf("const sweep = (notBefore = 0) =>");
    const b = src.indexOf("session.tmuxSweep = () =>");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const body = src.slice(a, b);
    expect(body).toContain("readFrameSwept(");
    expect(body).not.toContain("readFrameCached(");
    expect(body).not.toContain("readFrameFresh(");
    expect(body).not.toContain("phonesByWindow(");
  });
});

describe("the refresh bookkeeping stays small and honest", () => {
  test("readFrameCached never spawns tmux on the caller; only readFrameFresh does, and only endsession uses it", () => {
    const a = ctl.indexOf("export function readFrameCached(");
    const cached = ctl.slice(a, ctl.indexOf("\n}\n", a));
    expect(cached).toContain("refreshFrame(");
    expect(cached).not.toMatch(/\btmux\(/);
    expect(cached).not.toContain("spawnSync");
    const uses = [...src.matchAll(/readFrameFresh\(/g)].length;
    expect(uses).toBe(1);
    const end = src.indexOf('msg.cmd === "endsession"');
    expect(src.indexOf("readFrameFresh(c, 1_000)", end)).toBeGreaterThan(end);
    expect(src.indexOf("readFrameFresh(c, 1_000)", end) - end).toBeLessThan(2500);
  });
  test("one waiter per client, not one closure per tick", () => {
    expect(ctl).toContain("waiters.set(c.tty,");
    expect(ctl).not.toContain("set.add(onFresh)");
  });
  test("no dead catch, and a sync overwrite keeps the phones", () => {
    expect(ctl).not.toContain(".catch(() => {})");
    expect(ctl).toContain("phones: cur?.phones");
  });
  test("a missing phones set never means pending", () => {
    const a = ctl.indexOf("export function readFrameSwept(");
    const body = ctl.slice(a, ctl.indexOf("\n}\n", a));
    expect(body).toContain("const usable = !!cur && cur.at >= notBefore;");
  });
  test("the sweep's TTL is over its own tick, so an idle tick reuses the read", () => {
    const m = src.match(/const SWEEP_FRAME_TTL_MS = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(500);
    expect(src).toContain("readFrameSwept(session.tmuxClient, SWEEP_FRAME_TTL_MS,");
  });
});

describe.skipIf(!has)("readFrameSwept against a real tmux", () => {
  test("a first read is pending without spawning on the caller, then lands once and serves the frame", async () => {
    const a = landed();
    expect(a.r).toBe("pending");
    // The same session asking again while the refresh runs joins it, and keeps ONE waiter: the second ask replaces
    // the first, so the landing sweeps that session once, not once per tick it waited.
    const b = landed();
    expect(b.r).toBe("pending");
    expect(await settled(() => a.fires() + b.fires() === 1)).toBe(true);
    expect(b.fires()).toBe(1);
    const x = landed();
    const y = landed();
    expect(x.r).not.toBe("pending");
    expect(y.r).not.toBe("pending");
    if (x.r === "pending" || y.r === "pending") return;
    expect(x.r.frame?.windows.map((w) => w.name)).toContain("one");
    // One raw read feeds both: the parse is shared, the refresh was single-flight.
    expect(x.r.frame?.windows).toBe(y.r.frame?.windows);
  });

  test("notBefore is never answered from an older read, and the refresh sweeps again", async () => {
    // Fresh and inside the TTL, so only notBefore can force the refresh.
    expect(landed(0, 60_000).r).not.toBe("pending");
    raw(["rename-window", "-t", "desk:0", "two"]);
    const t = Date.now();
    const c = landed(t, 60_000);
    expect(c.r).toBe("pending");
    expect(await settled(() => c.fires() === 1)).toBe(true);
    const d = landed(t, 60_000);
    expect(d.r).not.toBe("pending");
    if (d.r === "pending") return;
    expect(d.r.frame?.windows.map((w) => w.name)).toContain("two");
  });

  test("phones are resolved once per refresh, with the window each one is on", async () => {
    raw(["new-session", "-d", "-t", "desk", "-s", "agx-phone-4242-ab"]);
    phone = clientOn("agx-phone-4242-ab");
    expect(await settled(() => out(["list-clients", "-F", "#{session_name}"]).includes("agx-phone-4242-ab"))).toBe(true);
    const t = Date.now();
    const a = landed(t);
    expect(await settled(() => a.fires() === 1)).toBe(true);
    const r = landed(t);
    expect(r.r).not.toBe("pending");
    if (r.r === "pending") return;
    const win = out(["display-message", "-p", "-t", "agx-phone-4242-ab", "#{window_id}"]);
    expect(r.r.phones.get(win)).toBe(1);
  });

  test("many calls during one refresh fire one waiter per client, once", async () => {
    raw(["rename-window", "-t", "desk:0", "three"]);
    const t = Date.now();
    let total = 0;
    for (let i = 0; i < 30; i++) readFrameSwept(client(), 450, t, () => { total++; });
    expect(await settled(() => total >= 1)).toBe(true);
    // Let any stray second firing show itself on the clock the refresh uses.
    const probe = landed(Date.now(), 450);
    expect(await settled(() => probe.fires() === 1)).toBe(true);
    expect(total).toBe(1);
  });

  test("a client served an older read is swept again only if the new read differs", async () => {
    const fresh = Date.now();
    const a = landed(fresh);
    expect(await settled(() => a.fires() === 1)).toBe(true);
    // Stale by TTL, usable: served now, refresh starts, nothing changed in tmux.
    const stale = landed(0, 0);
    expect(stale.r).not.toBe("pending");
    // Another client with nothing to serve rides the same refresh and says when it landed.
    const other = landed(Date.now(), 450, "/dev/pts/none");
    expect(other.r).toBe("pending");
    expect(await settled(() => other.fires() === 1)).toBe(true);
    expect(stale.fires()).toBe(0);
    raw(["rename-window", "-t", "desk:0", "four"]);
    const changed = landed(0, 0);
    const other2 = landed(Date.now(), 450, "/dev/pts/none");
    expect(await settled(() => other2.fires() === 1)).toBe(true);
    expect(changed.fires()).toBe(1);
  });

  test("a sync read over the shared entry does not make the sweep wait or lose the phones", async () => {
    raw(["new-session", "-d", "-t", "desk", "-s", "agx-phone-4343-cd"]);
    phone?.kill();
    phone = clientOn("agx-phone-4343-cd");
    expect(await settled(() => out(["list-clients", "-F", "#{session_name}"]).includes("agx-phone-4343-cd"))).toBe(true);
    const t = Date.now();
    const a = landed(t);
    expect(await settled(() => a.fires() === 1)).toBe(true);
    readFrameFresh(client(), 0);
    const r = landed(0, 60_000);
    expect(r.r).not.toBe("pending");
    if (r.r === "pending") return;
    expect(r.r.phones.size).toBeGreaterThan(0);
  });
});
