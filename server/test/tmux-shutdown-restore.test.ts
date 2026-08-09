/*
 * Restarting the server must not leave a window pinned at phone size.
 *
 * The audited fault, end to end: `shutdownTerminals` is what SIGINT/SIGTERM
 * reach, it hangs up the shells and empties the session map, and it never went
 * near `restoreWindows`. So a phone attached with `fit` on, plus a server
 * restart, left the user's own tmux window at 80x24 with `window-size manual`
 * written on it and one of its panes zoomed — permanently, with nothing on
 * screen to explain it. Same pinning as the bug that cost somebody seven
 * windows; a different door into it.
 *
 * Driven against a REAL server killed with a REAL signal, and not against
 * `shutdownTerminals` called as a function. The whole defect lives in the wiring
 * — `process.exit(0)` on the line after the handler, so a `setTimeout` restore
 * never gets a turn — and a direct call is exactly the shape that cannot see it.
 *
 * Its own tmux server, its own TMUX_TMPDIR, `-f /dev/null`. Not tidiness: this
 * machine's config loads tmux-continuum, which restores the USER'S REAL SESSIONS
 * into any server that starts, and a probe has already resized a window
 * somebody was working in. A test that fits a window to 80 columns must be
 * certain the window is one it made.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endPhoneSession } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";

/*
 * Short paths, and it is a hard limit rather than a preference: a unix socket
 * path is 108 bytes including the `tmux-<uid>` directory and the socket name,
 * and a path under the usual scratch directory does not fit — tmux answers
 * "File name too long" and every call in the file fails at once.
 *
 * The DIRECTORY carries the pid and the socket NAME stays fixed, and that split
 * is measured rather than chosen — ce905fa did both halves on the sibling file.
 * Sharing the directory AND the name means sharing one SERVER, so each run's
 * `killServer` in `beforeAll` tears down the other's fixture mid-assertion.
 * This repository is worked in by several sessions at once and two `bun test`
 * runs overlap constantly: two copies started together lost 3-8 tests apiece
 * where one copy alone loses none. Isolating the NAME instead is worse, not
 * better (18 apiece) — `tmuxSockets` hands EVERY server in a directory to
 * `listPanes`, so each run then sees the other's panes and the ambiguity guard
 * refuses them all, correctly.
 *
 * A pid is five or six of the 108 bytes above, which is why the prefix stays
 * this short. What the fixed directory bought was that a crashed run left a
 * server the next run's `killServer` reaped; that is given up here and
 * `afterAll` removes the whole directory instead. A crash now leaves one empty
 * directory, which is the honest price of not colliding.
 */
const TMPDIR = `/tmp/agx-tmux-shut-${process.pid}`;
const SOCK = "agx-shut";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const HAVE_TMUX = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

/** The environment a client this file FABRICATES gets. `process.env` is read at
 *  call time, never snapshotted, because `beforeAll` puts TMUX_TMPDIR into it
 *  after this module is evaluated — the measured Bun quirk the helpers above
 *  already work around. `TERM` is overridden rather than inherited: see
 *  tmuxTerm.ts for the 37 failures that came of inheriting it. */
const clientEnv = (): Record<string, string> => ({ ...process.env, TERM: TEST_TERM } as Record<string, string>);

/** `env` on every spawn, and it is not decoration: measured on Bun 1.3.9, a
 *  `Bun.spawnSync` with no `env` gets the environment as it was when the PROCESS
 *  started, not `process.env` as it is now — so the TMUX_TMPDIR set in
 *  `beforeAll` would reach the code under test and not this helper, and the
 *  fixture would build its server in a different directory from the one being
 *  measured. */
const tmux = (...args: string[]): string =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString();

const killServer = (): void => {
  Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore", env: process.env });
};

/** A tmux client on a pty of an exact size, the way a terminal emulator makes
 *  one — `script` builds its pty at 80x24 whatever COLUMNS says, so a desk built
 *  that way would be compared against a phone of the same width and pass for the
 *  wrong reason. Held open by a sleep; killed in afterAll. */
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

/** What tmux has for a window right now. `window-size` is read as the LOCAL
 *  value (`show-options -wv`), never the effective one: a window carrying
 *  nothing of its own answers `latest` for the effective value, and "latest" is
 *  indistinguishable from the option we are checking was removed. */
const geom = (w: string) => tmux("display-message", "-p", "-t", w, "#{window_width}x#{window_height}").trim();
const sizeOpt = (w: string) => tmux("show-options", "-wv", "-t", w, "window-size").trim();
const zoom = (w: string) => tmux("display-message", "-p", "-t", w, "#{window_zoomed_flag}").trim();
const state = (w: string) => ({ geom: geom(w), windowSize: sizeOpt(w), zoomed: zoom(w) });

let desk: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;
let dir = "";
let port = 0;
let paneId = "";
let win = "";
let other = "";

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  // Set here and put back in afterAll rather than at module load: `bun test`
  // runs a suite's files in one process, and the other tmux files are entitled
  // to the environment they were written against.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  killServer();

  // Two panes, because the zoom the phone applies is only meaningful on a window
  // that has more than one — `resize-pane -Z` on a single-pane window is a silent
  // no-op on 3.6a (exit 0, flag still 0), so a one-pane fixture would assert the
  // zoom came back off having never seen it go on.
  tmux("new-session", "-d", "-s", "work", "-x", "200", "-y", "50", "sh", "-c", "printf 'PANE-ONE\\n'; exec sh");
  tmux("split-window", "-h", "-t", "work", "sh", "-c", "printf 'PANE-TWO\\n'; exec sh");
  // A second window nobody is looking at. `window-size` is read per window and a
  // grouped session shares every window in the group, which is how one phone
  // pulled five windows down to 80 columns — so the blast radius is part of what
  // is being measured, not a bonus.
  tmux("new-window", "-d", "-t", "work", "sh", "-c", "exec sh");
  await Bun.sleep(400);
  // `listPanes` only reports servers somebody is attached to, so the desk client
  // is a precondition rather than scenery.
  desk = deskClient(200, 50, "work");
  await Bun.sleep(1200);

  // `-t work`, never `-a`: "the first pane on the server" is how a fixture ends
  // up holding one of the user's own restored sessions.
  const panes = tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n");
  // The SECOND pane deliberately — zooming the first would pass whether the
  // command names the pane that was tapped or just happens to zoom whatever is
  // top-left.
  paneId = panes[1] ?? "";
  win = tmux("display-message", "-p", "-t", paneId, "#{window_id}").trim();
  other = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n").filter((w) => w !== win)[0] ?? "";
  // Start from windows carrying nothing of ours, which is what the first phone to
  // visit a machine sees. Not the state after a fresh `new-session` by accident:
  // it is the state the restore has to be able to put back, so the file says
  // which one it is measuring from.
  for (const w of [win, other]) tmux("set-option", "-uw", "-t", w, "window-size");

  dir = join(TMPDIR, "agx-server");
  mkdirSync(dir, { recursive: true });
  port = 4970 + Math.floor(Math.random() * 20);
  server = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    /*
     * A named environment, never `...process.env` — and two of these entries
     * are load-bearing rather than habit.
     *
     * TMUX_TMPDIR is what confines the server under test to this file's tmux.
     * `tmuxSockets` lists that directory, so without it the server discovers
     * the developer's own server and can offer one of its panes as `%0`.
     *
     * LANG is the one nobody would guess, and it cost an hour here. With NO
     * locale in the environment, tmux renders the tab characters in a `-F`
     * format as `_`: measured on 3.6a, `list-panes -a -F '#{session_name}\t…'`
     * gives `work^I%0^I2935215` with a locale set and `work_%0_2935215` without
     * one. `PANE_FORMAT` is tab-separated and `parsePanes` drops any line with
     * fewer than eight fields, so pane discovery answered an empty list — the
     * phone got "that pane is gone" and nothing anywhere said why. It is a
     * property of the server's environment, not of this suite; see the report.
     */
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "C.UTF-8",
      TMUX_TMPDIR: TMPDIR,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // The pane engine gets a socket of its own that nothing else is on, so its
      // sweeper can never reach the fixture above.
      AGENTGLASS_TMUX_SOCKET: `${SOCK}-panes`,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(server.stderr as ReadableStream).text()).slice(0, 400));
}, 60_000);

afterAll(() => {
  try { server?.kill("SIGKILL"); } catch { /* already gone */ }
  desk?.kill();
  killServer();
  // The socket file, the server's XDG root and the socket directory itself all
  // live under TMPDIR, and TMPDIR is now this process's alone — so one removal
  // does what three did, and it takes the directory with it rather than leaving
  // an empty `tmux-<uid>` per run.
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing there */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

/** Open the phone's socket and wait for the server's `ready` frame. Control
 *  frames are JSON strings; the pty's own output arrives as bytes on the same
 *  socket, so only strings are parsed. */
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
      // Loudly, rather than as a timeout: "that pane is gone" means the fixture
      // and the server disagree about which tmux they are on, which is the one
      // failure that must never be read as a flake.
      if (frame.t === "fatal") { clearTimeout(fail); reject(new Error(String(frame.error))); }
    });
    ws.addEventListener("error", () => { clearTimeout(fail); reject(new Error("socket refused")); });
  });
}

describe.if(HAVE_TMUX)("a server going down gives the desk its window back", () => {
  test("the fixture is a two-pane window on a wide desk, carrying nothing of ours", () => {
    expect(paneId).toMatch(/^%\d+$/);
    expect(win).toMatch(/^@\d+$/);
    expect(other).toMatch(/^@\d+$/);
    // 200 columns, from this file's own `new-session -x 200`. Reading 80 here
    // means the fixture is not the fixture — it is something else's session on a
    // pty built at the default size.
    expect(state(win)).toEqual({ geom: "200x49", windowSize: "", zoomed: "0" });
    // 50 rows and not 49, measured: the status line costs a ROW on the window
    // the desk's client is displaying and on no other. Written out rather than
    // compared to `win` because the two really are different numbers and a
    // reader would otherwise take one of them for a typo.
    expect(state(other)).toEqual({ geom: "200x50", windowSize: "", zoomed: "0" });
    // And nothing else got in. A config-free server holds only what this file put
    // on it, which is the claim `-f /dev/null` is making.
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
  });

  test("SIGTERM puts back the width, the option and the zoom", async () => {
    const before = state(win);
    const beforeOther = state(other);
    expect(before).toEqual({ geom: "200x49", windowSize: "", zoomed: "0" });

    const ws = await phoneSocket();
    await Bun.sleep(2500);
    /*
     * The phone's footprint, as values, so the "after" below is a restore and
     * not a window that never moved. All three are on the DESK'S window: `fit`
     * is a `resize-window -x` on the shared window (which the manpage says sets
     * `window-size manual`), and the zoom is a flag on that same window.
     */
    expect(state(win)).toEqual({ geom: "80x24", windowSize: "manual", zoomed: "1" });
    // Measured, and it is the reason `attachArgvFor` uses `largest` plus one
    // explicit resize rather than `latest`: with `latest` this window went to
    // 80 too, along with every other window of the group.
    expect(geom(other)).toBe("200x50");
    // Still OPEN, and that is the case under test rather than a loose end: a
    // phone that is still there when the server is killed is the one whose
    // restore has no timer left to run it. Asserted here and not in a `finally`
    // — there is nothing to clean up, and an expectation that throws during
    // unwinding replaces the failure that actually mattered.
    expect(ws.readyState).toBe(WebSocket.OPEN);

    /*
     * A real SIGTERM, and then wait for the process to be gone rather than for a
     * duration. The restore is synchronous inside the handler — it has to be,
     * `process.exit(0)` is the next line — so once the process has exited there
     * is nothing left that could still be going to do it.
     */
    const t0 = Date.now();
    server!.kill("SIGTERM");
    await server!.exited;
    const tookMs = Date.now() - t0;
    // Let tmux act on the `refresh-client` the restore ends with. Not part of
    // the claim, only of reading it.
    await Bun.sleep(500);

    const after = state(win);
    /*
     * THE ASSERTION THIS FILE EXISTS FOR, and the one that fails on the version
     * before the fix — measured there as `80x24` / `manual` / `1`, unchanged by
     * the server going away and unchanged for as long as tmux keeps running.
     *
     * Empty, not `latest`: an option that was never on the window must be gone
     * from it, and putting `latest` back would leave our footprint written in
     * tmux's default clothing.
     */
    expect(after).toEqual(before);
    expect(after).toEqual({ geom: "200x49", windowSize: "", zoomed: "0" });
    /*
     * The window nobody was looking at, restored on the same pass: it carried
     * `largest` the moment the phone arrived (the `set-option -t <our session>`
     * in `attachArgvFor` lands on the shared window, not on our session), and
     * it is back to carrying nothing.
     *
     * Its ROW count used to be the one thing that did NOT come back to where it
     * started — 50 before, 49 after — and this file said so, calling it
     * `resize-window -A` doing what it says rather than a leak. It was a leak,
     * and it is the first of the three failures in #488: the teardown walked
     * every window of the group, because a grouped session shares them all, and
     * resized ones the phone had never been on. A window that carries the same
     * `window-size` it carried when the phone arrived is now left alone
     * entirely — no `-A`, no option write — so it keeps its own geometry.
     *
     * Asserted as `beforeOther.geom` rather than as a literal, so this reads as
     * "unchanged" and cannot quietly encode a new side effect the way the
     * literal did.
     */
    expect({ windowSize: sizeOpt(other), zoomed: zoom(other) })
      .toEqual({ windowSize: beforeOther.windowSize, zoomed: beforeOther.zoomed });
    expect(geom(other)).toBe(beforeOther.geom);
    expect(Number(geom(other).split("x")[0])).toBe(Number(beforeOther.geom.split("x")[0]));
    // Our own grouped session is gone with the server — it is what the shutdown
    // kills to make the restore allowed, and leaving it would be a session in
    // the user's `tmux ls` belonging to a process that no longer exists.
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
    // The desk's own session is untouched. The restore is a `resize-window` and
    // a `set-option`, never a `kill-session` on anything but our own name.
    expect(tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n")).toHaveLength(2);
    // Fast enough for a signal handler. Measured on this machine; recorded so a
    // change that turns the shutdown into something a user waits through shows
    // up as a number rather than as a feeling.
    expect(tookMs).toBeLessThan(3000);
  }, 90_000);

  test("and the window follows a client's size again afterwards", async () => {
    /*
     * The proof that an unset option is not cosmetic. A window left `manual` —
     * what shipped — sits at its old size and ignores every client from then on,
     * which is the part of the bug the user actually feels: their own terminal
     * stops reflowing tmux and nothing says why.
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

  test("nothing but a session this app named can be killed", () => {
    /*
     * `kill-session` is the most destructive command in tmuxctl, and this guard
     * is the whole reason `endPhoneSession` is a function rather than an inlined
     * call on the shutdown path. `work` is the fixture's own session and stands
     * in for the user's: it is live, it is on our socket, and it must survive
     * every one of these.
     */
    for (const name of ["work", "", "$0", "agx-phone", "agx-phone-0-x; kill-server", "agx-phone-*-x", "AGX-PHONE-0-x"]) {
      expect(endPhoneSession(["-L", SOCK], name)).toBe(false);
    }
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
    expect(tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n")).toHaveLength(2);
  });
});
