/*
 * A server that is KILLED must still give the window back — on the next boot.
 *
 * The sibling file, tmux-shutdown-restore.test.ts, drives the clean path:
 * SIGTERM reaches a handler, `shutdownTerminals` runs, `restoreWindows` puts
 * the desk's window back before `process.exit(0)`. That covers every way this
 * app is asked to stop and none of the ways it is stopped.
 *
 * SIGKILL runs no handler at all. Neither does an OOM kill, a `kill -9` from a
 * frustrated developer, or the machine going down. What is left behind is the
 * exact thing a user reported with a screenshot after a day of hard kills — one
 * window of a five-window session pinned, and no way to know why:
 *
 *   work:2  agent-a  267x59  window-size=latest
 *   work:3  agent-b  267x59  window-size=latest
 *   work:4  agent-c  267x59  window-size=latest
 *   work:5  agent-d  277x54  window-size=manual   <- the only one
 *   work:6  agent-e  267x59  window-size=latest
 *
 * 54 rows against a 59-row client: the five missing rows were the gap along the
 * bottom of his terminal. So this file asserts the state AFTER the SIGKILL as
 * well — the pinning has to be real for the recovery to mean anything, and a
 * fixture that quietly restored itself would pass either way.
 *
 * Two servers, in sequence, against one tmux. The second one is the fix: it is
 * the boot sweep that finds `@agx-had-size` on a window no live phone is using
 * and puts `window-size` back.
 *
 * Its own tmux server, its own TMUX_TMPDIR, `-f /dev/null` — this machine's
 * config loads tmux-continuum, which restores the USER'S REAL SESSIONS into any
 * server that starts, and a probe here has already resized a window somebody
 * was working in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_TERM } from "./tmuxTerm.ts";

/*
 * Short, for the 108-byte unix socket path limit — a pid is five or six of
 * those bytes, which is why the prefix stays this small.
 *
 * The DIRECTORY carries the pid and the socket NAME stays fixed, measured on
 * the sibling file in ce905fa. Sharing the directory AND the name means sharing
 * one SERVER, and each run's `killServer` in `beforeAll` then tears down the
 * other's fixture mid-assertion — several sessions work in this repository at
 * once, so two `bun test` runs overlap constantly, and two copies started
 * together lost 3-8 tests apiece where one alone loses none. Isolating the NAME
 * instead is worse (18 apiece): `tmuxSockets` hands every server in a directory
 * to `listPanes`, so each run sees the other's panes and the ambiguity guard
 * refuses them all.
 *
 * The fixed directory used to mean a crashed run left a server the next run
 * reaped; `afterAll` removes the whole directory instead, so a crash leaves one
 * empty directory. That is the price of not colliding.
 */
const TMPDIR = `/tmp/agx-tmux-kill-${process.pid}`;
const SOCK = "agx-kill";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const HAVE_TMUX = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

/** The environment a client this file FABRICATES gets. `process.env` is read at
 *  call time, never snapshotted, because `beforeAll` puts TMUX_TMPDIR into it
 *  after this module is evaluated — the measured Bun quirk the helpers above
 *  already work around. `TERM` is overridden rather than inherited: see
 *  tmuxTerm.ts for the 37 failures that came of inheriting it. */
const clientEnv = (): Record<string, string> => ({ ...process.env, TERM: TEST_TERM } as Record<string, string>);

/** `env` on every spawn: measured on Bun 1.3.9, a `Bun.spawnSync` with no `env`
 *  gets the environment as it was when the PROCESS started, so the TMUX_TMPDIR
 *  set in `beforeAll` would reach the code under test and not this helper. */
const tmux = (...args: string[]): string =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString();

const killServer = (): void => {
  Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore", env: process.env });
};

/** A tmux client on a pty of an exact size, the way a terminal emulator makes
 *  one. `script` builds its pty at 80x24 whatever COLUMNS says, so a desk built
 *  that way would be the same width as the phone and pass for the wrong
 *  reason. */
function deskClient(cols: number, rows: number, target: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,fcntl,struct,termios,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[4]),int(sys.argv[3]),0,0))\n" +
      "time.sleep(600)\n",
      SOCK, target, String(cols), String(rows)],
    { stdout: "ignore", stderr: "ignore", env: clientEnv() },
  );
}

/** The LOCAL `window-size`, never `#{window-size}`: a window carrying nothing
 *  of its own answers `latest` for the effective value, which is exactly the
 *  answer that must be distinguishable from "the option is gone". */
const sizeOpt = (w: string) => tmux("show-options", "-qwv", "-t", w, "window-size").trim();
const geom = (w: string) => tmux("display-message", "-p", "-t", w, "#{window_width}x#{window_height}").trim();
/** The durable mark itself. The fix hangs entirely off this option existing,
 *  so the test reads it rather than inferring it from behaviour. */
const mark = (w: string) => tmux("show-options", "-qwv", "-t", w, "@agx-had-size").trim();

let desk: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;
let dir = "";
let port = 0;
let paneId = "";
let win = "";

const serverEnv = () => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  // Without a locale tmux renders the tab in a `-F` format as `_`, every
  // tab-separated parse in tmuxctl answers an empty list, and pane discovery
  // says "that pane is gone" with nothing to say why. Cost an hour once.
  LANG: process.env.LANG ?? "C.UTF-8",
  TMUX_TMPDIR: TMPDIR,
  XDG_CONFIG_HOME: dir,
  AGENTGLASS_ROOT: dir,
  AGENTGLASS_DB: join(dir, "f.db"),
  AGENTGLASS_SCAN_DISABLED: "1",
  AGENTGLASS_PORT: String(port),
  // The pane engine gets a socket nothing else is on, so its sweeper can never
  // reach the fixture.
  AGENTGLASS_TMUX_SOCKET: `${SOCK}-panes`,
});

async function startServer(): Promise<ReturnType<typeof Bun.spawn>> {
  const p = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: serverEnv(), stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return p; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(p.stderr as ReadableStream).text()).slice(0, 400));
}

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  killServer();

  tmux("new-session", "-d", "-s", "work", "-x", "200", "-y", "50", "sh", "-c", "printf 'PANE-ONE\\n'; exec sh");
  tmux("split-window", "-h", "-t", "work", "sh", "-c", "printf 'PANE-TWO\\n'; exec sh");
  await Bun.sleep(400);
  // `listPanes` only reports servers somebody is attached to, so the desk client
  // is a precondition rather than scenery.
  desk = deskClient(200, 50, "work");
  await Bun.sleep(1200);

  // `-t work`, never `-a`: "the first pane on the server" is how a fixture ends
  // up holding one of the user's own restored sessions.
  const panes = tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n");
  paneId = panes[1] ?? "";
  win = tmux("display-message", "-p", "-t", paneId, "#{window_id}").trim();
  // From a window carrying nothing of ours, which is what the first phone to
  // visit a machine finds — and which is what the restore has to put back.
  tmux("set-option", "-uw", "-t", win, "window-size");

  dir = join(TMPDIR, "agx-server");
  mkdirSync(dir, { recursive: true });
  port = 4930 + Math.floor(Math.random() * 20);
  server = await startServer();
}, 60_000);

afterAll(() => {
  try { server?.kill("SIGKILL"); } catch { /* already gone */ }
  desk?.kill();
  killServer();
  // Socket file, server root and socket directory all live under TMPDIR, and
  // TMPDIR is this process's alone — one removal does what three did.
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing there */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

/** Open the phone's socket and wait for the server's `ready` frame. */
function phoneSocket(): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}/terminal/pty?pane=${encodeURIComponent(paneId)}&fit=1&cols=80&rows=24`;
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error("no ready frame")), 15_000);
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let frame: { t?: string; error?: string };
      try { frame = JSON.parse(e.data); } catch { return; }
      if (frame.t === "ready") { clearTimeout(fail); resolve(ws); }
      // Loudly rather than as a timeout: "that pane is gone" means the fixture
      // and the server disagree about which tmux they are on, which is the one
      // failure that must never be read as a flake.
      if (frame.t === "fatal") { clearTimeout(fail); reject(new Error(String(frame.error))); }
    });
    ws.addEventListener("error", () => { clearTimeout(fail); reject(new Error("socket refused")); });
  });
}

describe.if(HAVE_TMUX)("a server that is killed outright is repaired by the next one", () => {
  test("the fixture is a two-pane window on a wide desk, carrying nothing of ours", () => {
    expect(paneId).toMatch(/^%\d+$/);
    expect(win).toMatch(/^@\d+$/);
    expect({ geom: geom(win), windowSize: sizeOpt(win), mark: mark(win) })
      .toEqual({ geom: "200x49", windowSize: "", mark: "" });
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
  });

  test("a fitted phone writes the way back onto the window itself", async () => {
    await phoneSocket();
    await Bun.sleep(2500);
    /*
     * The footprint, and the record of what it replaced, side by side. The
     * `manual` is the fit — `resize-window -x` on the shared window, which the
     * manpage says sets it — and `none` is this change: the window carried no
     * `window-size` of its own, and the sentinel says so, because an unset user
     * option and one set to "" are the same thing in a tmux format.
     */
    expect({ geom: geom(win), windowSize: sizeOpt(win), mark: mark(win) })
      .toEqual({ geom: "80x24", windowSize: "manual", mark: "none" });
  }, 60_000);

  test("SIGKILL leaves the window pinned — that is the bug, and it must be real", async () => {
    server!.kill("SIGKILL");
    await server!.exited;
    /*
     * Long enough for anything that was going to heal on its own to have done
     * so. `cleanup`'s two restores are at +1500ms and +3000ms and a SIGKILLed
     * process runs neither; if this ever starts passing by itself, the premise
     * of the file has changed and the next test proves nothing.
     */
    await Bun.sleep(4000);
    expect({ windowSize: sizeOpt(win), mark: mark(win) }).toEqual({ windowSize: "manual", mark: "none" });
    expect(geom(win)).toBe("80x24");
    /*
     * And the phone's grouped session is gone, which is what makes the window
     * eligible at all. Measured rather than assumed: the pty is `setsid`, so it
     * outlives the SIGKILL as a process — but its stdout pipe was held by the
     * server, so the first write after the server died takes the tmux client
     * down with SIGPIPE and `destroy-unattached on` ends the session. This is
     * the load-bearing half of "no live phone is using it"; if an orphan ever
     * did survive here, the sweep would skip the window and be right to.
     */
    expect(tmux("list-sessions", "-F", "#{session_name}").trim().split("\n")).toEqual(["work"]);
  }, 30_000);

  test("the next server puts it back at boot, unprompted", async () => {
    server = await startServer();
    // No client, no panel, no phone — just the boot. The sweep is synchronous
    // and runs before `/health` can be answered, so by the time `startServer`
    // returns it has already happened; the pause is for tmux to act on the
    // `refresh-client` it ends with.
    await Bun.sleep(800);
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Empty, not `latest`: an option that
     * was never on the window has to be GONE from it, and writing tmux's
     * default back would leave our footprint in tmux's clothing. And the mark
     * is gone too — a mark that survived its own restore would have the boot
     * after this one act on a window it no longer owns.
     */
    expect({ windowSize: sizeOpt(win), mark: mark(win) }).toEqual({ windowSize: "", mark: "" });
    // The size itself, back to the desk's client. `resize-window -A` is what
    // asks for it: changing the option alone leaves a window still squeezed,
    // measured, because tmux only applies `window-size` when something makes it
    // recompute.
    expect(geom(win)).toBe("200x49");
    // Nothing else moved. The sweep is a `resize-window` and a `set-option`,
    // never a `kill-session`.
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
    expect(tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n")).toHaveLength(2);
  }, 60_000);

  test("and the window follows a client's size again afterwards", async () => {
    /*
     * The proof that an unset option is not cosmetic. A window left `manual`
     * sits at its old size and ignores every client from then on — the part of
     * the bug the user actually feels: their terminal stops reflowing tmux and
     * nothing says why.
     */
    const narrow = deskClient(120, 40, "work");
    try {
      await Bun.sleep(2000);
      expect(Number(geom(win).split("x")[0])).toBe(120);
    } finally {
      narrow.kill();
      await Bun.sleep(800);
    }
  }, 30_000);

  test("a window the app never marked is not touched, however it is set", async () => {
    /*
     * THE CONVERSE, and the thing that would make this whole change a bug
     * rather than a fix: a user may set `window-size manual` themselves, and a
     * sweep that went looking for `manual` instead of for its own mark would
     * take it off them at every boot.
     *
     * A window the phone never visited, pinned by hand, through a boot.
     */
    tmux("new-window", "-d", "-t", "work");
    const mine = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n").filter((w) => w !== win).pop() ?? "";
    expect(mine).toMatch(/^@\d+$/);
    tmux("resize-window", "-t", mine, "-x", "111", "-y", "37");
    expect({ geom: geom(mine), windowSize: sizeOpt(mine), mark: mark(mine) })
      .toEqual({ geom: "111x37", windowSize: "manual", mark: "" });

    server!.kill("SIGKILL");
    await server!.exited;
    server = await startServer();
    await Bun.sleep(800);

    expect({ geom: geom(mine), windowSize: sizeOpt(mine) }).toEqual({ geom: "111x37", windowSize: "manual" });
    tmux("kill-window", "-t", mine);
  }, 90_000);

  test("a mark INHERITED from a global option claims nothing", async () => {
    /*
     * The way the ownership check could have been wrong, measured rather than
     * imagined: `#{@agx-had-size}` in a format reads the EFFECTIVE value, so
     * one `set-option -gw` makes every window on the server answer as though it
     * were marked. A sweep built on the format alone would put `window-size`
     * back on windows it had never touched — and would do it again at every
     * boot for ever, because `set-option -uw` cannot clear a global.
     *
     * Two windows pinned by hand, a global mark that says they were carrying
     * nothing, and a boot. Nothing may move.
     */
    tmux("new-window", "-d", "-t", "work");
    const all = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n");
    const theirs = all.filter((w) => w !== win);
    expect(theirs.length).toBeGreaterThan(0);
    for (const w of theirs) tmux("resize-window", "-t", w, "-x", "99", "-y", "31");
    tmux("set-option", "-gw", "@agx-had-size", "none");
    // The trap in one assertion: the format says "marked", the local option
    // says "nothing of its own", and only the second is the truth.
    expect(tmux("list-windows", "-t", "work", "-F", "#{@agx-had-size}").trim().split("\n").every((v) => v === "none")).toBe(true);
    expect(mark(theirs[0]!)).toBe("");

    server!.kill("SIGKILL");
    await server!.exited;
    server = await startServer();
    await Bun.sleep(800);

    for (const w of theirs) {
      expect({ id: w, geom: geom(w), windowSize: sizeOpt(w) }).toEqual({ id: w, geom: "99x31", windowSize: "manual" });
    }
    tmux("set-option", "-guw", "@agx-had-size");
    for (const w of theirs) tmux("kill-window", "-t", w);
  }, 90_000);
});
