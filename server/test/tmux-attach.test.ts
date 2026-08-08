/*
 * Showing a live tmux pane to a phone, against a real tmux server.
 *
 * Two claims, and neither can be checked without running tmux:
 *
 *   1. The command reaches work that is ALREADY RUNNING — it sees what is on
 *      that pane's screen and what it types executes there. Anything less is a
 *      second empty shell beside the work rather than the work.
 *
 *   2. It does not squeeze the desk. tmux sizes a window to whichever client
 *      used it last, so the obvious `attach -t` drags a 200-column session down
 *      to phone width for as long as somebody is looking — and so does a
 *      grouped session on its own, which is the part that had to be measured
 *      rather than assumed. `window-size largest`, set on a session named here
 *      and belonging to us, is what actually holds it.
 *
 * The desk client is a pty sized with TIOCSWINSZ, because `script` builds its
 * pty at 80x24 whatever COLUMNS says — the first version of this check compared
 * 80 against 80 and reported a pass.
 *
 * Its own socket, never the developer's: this creates and kills a tmux server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { attachArgvFor, readFrame, runAction, restoreWindows, phoneWindows, type TmuxTarget } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";

const SOCK = "agx-attach-test";
/*
 * A socket DIRECTORY of our own, not just a socket name — and it is load-bearing
 * rather than tidy.
 *
 * `tmuxSockets` searches `$TMUX_TMPDIR/tmux-<uid>` and hands every server in it
 * to `listPanes`, so with the default directory this suite's fixture shares an
 * id space with the developer's own tmux. That is not hypothetical: this file's
 * two-pane fixture came up holding `%3` and `%4`, and the machine it was written
 * on had `%3` and `%4` on the user's real server. `attachArgvFor` refused every
 * one of them — correctly, it is the ambiguity guard that exists because a fit
 * once resized a window somebody was working in — and six tests failed for a
 * reason that had nothing to do with what they were testing.
 *
 * It also closes the near-miss described below at its source. With the search
 * confined to a directory this file owns, "the search carries on to the real
 * one" has nowhere to carry on TO.
 *
 * Short on purpose: a unix socket path is 108 bytes including the `tmux-<uid>`
 * and the socket name, and a path under the usual scratch directory does not
 * fit — measured, tmux answers "File name too long" and every call fails.
 *
 * Per PROCESS, because this repository is worked in by several sessions at
 * once and two `bun test` runs overlap constantly.
 *
 * Measured, and both halves matter. Sharing the directory AND the socket name
 * meant sharing one server: each run's `killServer` tore down the other's
 * fixture mid-assertion — this file alone passes 24/24, two copies started
 * together failed 5 apiece, every time. Giving them different socket NAMES in
 * the same directory made it worse, not better (18 apiece), and the paragraph
 * above says why: the search hands EVERY server in the directory to
 * `listPanes`, so each run then saw the other's panes and the ambiguity guard
 * refused them all — correctly.
 *
 * So the directory is what gets isolated, and the socket name inside it stays
 * fixed, which keeps the property that made it fixed: a run that crashes leaves
 * a server the next run's `killServer` reaps.
 *
 * Short on purpose, still: the 108-byte limit below is measured, and a pid is
 * five or six of those bytes.
 */
const TMPDIR = `/tmp/agx-tmux-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const HAVE_TMUX = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

/** The environment a client this file FABRICATES gets. `process.env` is read at
 *  call time, never snapshotted, because `beforeAll` puts TMUX_TMPDIR into it
 *  after this module is evaluated — the measured Bun quirk the helpers above
 *  already work around. `TERM` is overridden rather than inherited: see
 *  tmuxTerm.ts for the 37 failures that came of inheriting it. */
const clientEnv = (): Record<string, string> => ({ ...process.env, TERM: TEST_TERM } as Record<string, string>);

/**
 * Our socket, named to `attachArgvFor` — and then checked again on the way out.
 *
 * Both matter, and the reason is the worst near-miss this suite has had. The
 * calls below used to pass `undefined`, which means "look on every tmux server
 * in the socket directory", and `listPanes` skips a server nobody is attached
 * to. So on a run where the fixture's client had not come up yet, `%0` resolved
 * to a pane on the DEVELOPER'S OWN tmux — and the next line of the live test
 * writes `printf 'FROM-THE-PHONE'` into whatever it attached to. It never got
 * that far, but only because the assertion above it failed first.
 *
 * Naming the socket puts ours in front (`tmuxSockets` orders the known one
 * first and the lookup takes the first match), which fixes the ordinary case.
 * It does not fix the fallthrough — if our server is momentarily invisible the
 * search carries on to the real one — so the command is checked again on the
 * way out, against BOTH our socket and the session this file created. The
 * socket alone is not enough: the near-miss happened on our own socket, with
 * the user's sessions restored into it.
 */
const OURS = ["-L", SOCK];
const ours = (built: { argv: string[] } | null): boolean =>
  !!built
  && built.argv.some((a) => a.endsWith(`/${SOCK}`))
  && !!sessionId && built.argv.includes(sessionId);

/*
 * `-f /dev/null`: the server this test starts reads NO configuration.
 *
 * Not tidiness — it is the whole reason this suite once attached to the
 * developer's own shell. This machine's `~/.tmux.conf` loads tmux-resurrect and
 * tmux-continuum, and continuum restores on server start: the moment `beforeAll`
 * created a server, the user's real sessions were rebuilt INSIDE it, in their
 * real directories. The fixture then took "the first pane on the server" and got
 * one of those, and the live test types into whatever it was handed.
 *
 * It also cost an afternoon of a different kind: a probe looking for tmux's
 * stock window list reported "no status bar" on a desk that plainly had one,
 * because this config replaces `window-status-format`. A test server that reads
 * somebody's dotfiles is measuring their dotfiles.
 *
 * `env: process.env` on every spawn in this file, and it is not decoration.
 * Measured on Bun 1.3.9: a `Bun.spawnSync` with no `env` gets the environment
 * as it was when the PROCESS started, not `process.env` as it is now — so the
 * `TMUX_TMPDIR` set in `beforeAll` reached `tmuxctl.ts` (which passes it) and
 * not this helper, and the fixture built its server in the default directory
 * while the code under test looked for it in ours. Every test failed, none of
 * them for its own reason.
 */
const tmux = (...args: string[]): string =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", SOCK, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
    .stdout.toString();

const killServer = (): void => {
  Bun.spawnSync(["tmux", "-L", SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore", env: process.env });
};

/** A tmux client on a pty of an exact size, the way a terminal emulator makes
 *  one. Held open by a sleep; killed in afterAll. */
function wideClient(cols: number, rows: number, target: string, sock: string = SOCK): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,fcntl,struct,termios,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',int(sys.argv[4]),int(sys.argv[3]),0,0))\n" +
      "time.sleep(600)\n",
      // The socket is a PARAMETER and not the constant it used to be: with it
      // hardcoded, a second server built for a collision test never got a
      // client, listPanes skipped it, and the collision the test existed to
      // create silently did not exist.
      sock, target, String(cols), String(rows)],
    { stdout: "ignore", stderr: "ignore", env: clientEnv() },
  );
}

let desk: ReturnType<typeof Bun.spawn> | null = null;
let paneId = "";
let sessionId = "";
let deskWidth = 0;

beforeAll(async () => {
  if (!HAVE_TMUX) return;
  // Set here and put back in afterAll rather than at module load: `bun test`
  // runs the files of a suite in one process, and the other tmux tests are
  // entitled to the environment they were written against.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  killServer();
  tmux("new-session", "-d", "-s", "work", "-x", "200", "-y", "50",
    "sh", "-c", "printf 'THE-PANE-IS-ALIVE\\n'; exec sh");
  await Bun.sleep(400);
  // listPanes only reports servers somebody is attached to, which is deliberate
  // (see its comment) — so the desk client is a precondition, not decoration.
  desk = wideClient(200, 50, "work");
  await Bun.sleep(1200);
  // `-t work`, never `-a`. "The first pane on the server" is how this fixture
  // came back holding one of the user's own restored sessions — see the note on
  // `-f /dev/null` above. The pane under test is the one this file created.
  paneId = tmux("list-panes", "-t", "work", "-F", "#{pane_id}").trim().split("\n")[0] ?? "";
  sessionId = tmux("display-message", "-p", "-t", "work", "#{session_id}").trim();
  deskWidth = Number(tmux("display-message", "-p", "-t", paneId, "#{pane_width}").trim());
});

afterAll(() => {
  desk?.kill();
  killServer();
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  // The directory carries a pid now, so it is a new one every run and nobody
  // would ever reap it. A crashed run still leaves its own behind — which is
  // the honest trade for not colliding, and it is an empty directory.
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

describe.if(HAVE_TMUX)("attaching a phone to a pane that already exists", () => {
  test("the fixture is a wide desk with something running in it", () => {
    expect(paneId).toMatch(/^%\d+$/);
    expect(sessionId).toMatch(/^\$\d+$/);
    // 200 columns, from this file's own `new-session -x 200`. When this read 80
    // the fixture was not the fixture — it was a restored session of the user's,
    // on a pty `script` had built at its default size.
    expect(deskWidth).toBeGreaterThan(100);
    // And nothing else got in. A config-free server holds exactly what was put
    // on it, which is the claim `-f /dev/null` is making.
    expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("work");
  });

  test("no command is built for anything that is not a live pane", () => {
    // The id goes onto a command line, so this is the boundary that matters.
    // A caller can only ever name a pane the machine is really running.
    expect(attachArgvFor(OURS, "%99999")).toBeNull();
    expect(attachArgvFor(OURS, "; rm -rf /")).toBeNull();
    expect(attachArgvFor(OURS, "")).toBeNull();
    expect(attachArgvFor(OURS, "$0")).toBeNull();
  });

  test("and the one it builds says exactly what it does", () => {
    const built = attachArgvFor(OURS, paneId, "fixed");
    expect(ours(built)).toBe(true);
    expect(built).not.toBeNull();
    expect(built!.session).toBe(`agx-phone-${paneId.slice(1)}-fixed`);
    const argv = built!.argv;
    expect(argv[0]).toBe("tmux");
    // Grouped, under our own name — not `attach`, which is the call that drags
    // the desk down to phone width.
    expect(argv).toContain("new-session");
    expect(argv).not.toContain("attach");
    expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2)).toEqual(["-s", built!.session]);
    // The measured part. Without this the grouped session is decoration.
    const opt = argv.indexOf("set-option");
    expect(argv.slice(opt, opt + 6))
      .toEqual(["set-option", "-t", built!.session, "window-size", "largest"].concat(";"));
    // tmux's own window list, off. The app draws that strip itself, and two of
    // them stacked on a phone is a row of screen spent saying the same thing
    // twice. Sliced around `status` rather than matched loosely, because the
    // argument that matters is the `-t` in front of it: on our session this is
    // one row of ours, on the desk's it is the user's configuration.
    const st = argv.indexOf("status");
    expect(argv.slice(st - 3, st + 3))
      .toEqual(["set-option", "-t", built!.session, "status", "off"].concat(";"));
    // And it lands on the pane that was tapped rather than wherever the group
    // happened to be, which is whatever the desk last looked at.
    expect(argv.slice(-3)).toEqual(["select-pane", "-t", paneId]);
    // Nothing here reflows anything: no fit was asked for.
    expect(argv).not.toContain("resize-window");
  });

  test("a fit costs exactly the window that was opened", () => {
    const built = attachArgvFor(OURS, paneId, "fixed", true, { cols: 80, rows: 24 })!;
    expect(ours(built)).toBe(true);
    const argv = built.argv;
    /*
     * `latest` is the one word that must never come back. It is an option read
     * per window on a session that shares every window in the group, so it
     * sized FOUR windows somebody was not looking at down to phone width — the
     * bug this shape exists to answer.
     */
    expect(argv).not.toContain("latest");
    const opt = argv.indexOf("set-option");
    expect(argv.slice(opt, opt + 6))
      .toEqual(["set-option", "-t", built.session, "window-size", "largest"].concat(";"));
    // One resize, naming the window that was opened and nothing else. The
    // window id is read off the fixture rather than written here: the point of
    // the assertion is that the resize is TARGETED, so the target is the part
    // that has to be real.
    const window = tmux("display-message", "-p", "-t", paneId, "#{window_id}").trim();
    expect(window).toMatch(/^@\d+$/);
    const at = argv.indexOf("resize-window");
    expect(at).toBeGreaterThan(0);
    expect(argv.slice(at, at + 7))
      .toEqual(["resize-window", "-t", window, "-x", "80", "-y", "24"]);
    expect(argv.filter((a) => a === "resize-window")).toHaveLength(1);
  });

  test("an id two servers both claim opens neither", async () => {
    /*
     * The one that actually happened, and it reached somebody's real work.
     *
     * Pane ids belong to a SERVER, not to a machine, so `%1` is an ordinary id
     * on every tmux running here. A caller meant `%1` on its own test server;
     * the lookup took the first match across all of them, answered with `%1` on
     * the developer's, and a fit resized a window they were working in down to
     * 80 columns. Nothing about that looked like a mistake afterwards — it
     * looked like the machine had done something odd on its own.
     */
    const second = "agx-attach-test-2";
    const t2 = (...args: string[]): string =>
      Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", second, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
        .stdout.toString();
    t2("kill-server");
    try {
      t2("new-session", "-d", "-s", "other", "-x", "100", "-y", "30", "sh", "-c", "exec sh");
      await Bun.sleep(400);
      // listPanes only reports servers somebody is on, so the collision only
      // exists once this one has a client — which is also the only case that
      // could ever have been picked by mistake.
      const client = wideClient(100, 30, "other", second);
      await Bun.sleep(1500);
      try {
        const twin = t2("list-panes", "-t", "other", "-F", "#{pane_id}").trim().split("\n")[0] ?? "";
        // Only meaningful if the two servers really did land on the same id.
        // They do on a fresh pair — both start at %0 — and if some day they do
        // not, this says so rather than passing for the wrong reason.
        if (twin === paneId) {
          expect(attachArgvFor(OURS, paneId, "fixed", true, { cols: 80, rows: 24 })).toBeNull();
          expect(attachArgvFor(undefined, paneId)).toBeNull();
        } else {
          expect(twin).toMatch(/^%\d+$/);
        }
      } finally {
        client.kill();
      }
    } finally {
      t2("kill-server");
    }
  }, 30_000);

  test("and a fit with no size given leaves the window alone", () => {
    // Rather than guessing at one. A window resized to a number nobody sent is
    // worse than a window that was not resized.
    const built = attachArgvFor(OURS, paneId, "fixed", true)!;
    expect(built.argv).not.toContain("resize-window");
    expect(built.argv).not.toContain("latest");
  });

  test("the phone sees the work, types into it, and leaves the desk alone", async () => {
    const built = attachArgvFor(OURS, paneId)!;
    // The guard, and it is not ceremony. Everything below this line types into
    // whatever the command attached to. See `ours` above for what went wrong.
    expect(ours(built)).toBe(true);
    const phone = Bun.spawn(
      ["script", "-qfec", built.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: clientEnv() },
    );
    let seen = "";
    const reading = (async () => {
      for await (const chunk of phone.stdout as ReadableStream<Uint8Array>) {
        seen += new TextDecoder().decode(chunk);
      }
    })();

    try {
      await Bun.sleep(1500);
      // What was on that pane before the phone existed.
      expect(seen).toContain("THE-PANE-IS-ALIVE");

      // And the other direction. Checked by capturing the pane on the SERVER
      // rather than by reading our own echo, which is the difference between
      // "the bytes left" and "the shell ran it".
      phone.stdin.write("printf 'FROM-THE-PHONE\\n'\r");
      phone.stdin.flush();
      await Bun.sleep(1500);
      expect(tmux("capture-pane", "-p", "-t", paneId)).toContain("FROM-THE-PHONE");

      // The control, and the reason the command is shaped the way it is.
      expect(Number(tmux("display-message", "-p", "-t", paneId, "#{pane_width}").trim()))
        .toBe(deskWidth);

      // Its own session, recognisably ours, beside the user's rather than in it.
      const sessions = tmux("list-sessions", "-F", "#{session_name}").trim().split("\n");
      expect(sessions).toContain("work");
      const ours = sessions.find((s) => s.startsWith("agx-phone-"));
      expect(ours).toBeDefined();

      // The status line comes off OUR session and no other. Asserted against
      // the global value rather than against "on", because the claim is that
      // the desk still shows whatever this user's config asks for — a machine
      // configured without a status line must not read as a failure here.
      // `show-options -t` prints only what is set ON the session, so an empty
      // string is the desk carrying nothing of ours.
      const asConfigured = tmux("show-options", "-gv", "status").trim();
      expect(tmux("display-message", "-p", "-t", "work", "#{status}").trim()).toBe(asConfigured);
      expect(tmux("show-options", "-t", "work", "status").trim()).toBe("");
      expect(tmux("display-message", "-p", "-t", ours!, "#{status}").trim()).toBe("off");
    } finally {
      phone.kill();
      await reading.catch(() => { /* the stream ends with the process */ });
    }
  }, 30_000);
});

/*
 * The desk asking for its columns back, and the window it gets them on.
 *
 * Everything here is a tmux behaviour that cannot be reasoned about, only run:
 * `resize-window -A` SETS `window-size manual` (so the command that un-squeezes
 * a window is also the command that stops the desk's own terminal reflowing it
 * ever again), and unsetting the option while a phone is attached hands the
 * window straight back to the phone. Both were measured on a private server
 * before the code was written; these are the same measurements as assertions.
 *
 * Ordered: each test leaves the window where the next one expects it. That is
 * the shape of the thing being tested — a lifecycle — and splitting it into
 * independent tests would mean building the phone attach four times.
 */
describe.if(HAVE_TMUX)("taking the width back from a phone", () => {
  let phone: ReturnType<typeof Bun.spawn> | null = null;
  let built: ReturnType<typeof attachArgvFor> = null;
  let win = "";
  let others: string[] = [];
  let target: TmuxTarget;

  /** What tmux has for a window right now: its grid, and what `window-size` is
   *  set to ON it (empty when the window carries none of its own — the state a
   *  window is in before any of this touched it). */
  const geom = (w: string) => tmux("display-message", "-p", "-t", w, "#{window_width}x#{window_height}").trim();
  const opt = (w: string) => tmux("show-options", "-wv", "-t", w, "window-size").trim();
  const cols = (w: string) => Number(geom(w).split("x")[0]);
  /** The desk's own terminal, picked out of a client list that also has a phone
   *  on it — the whole point being that the phone stays attached. */
  const deskTty = () => tmux("list-clients", "-F", "#{client_session}\t#{client_tty}")
    .split("\n").find((l) => l.startsWith("work\t"))?.split("\t")[1] ?? "";

  beforeAll(async () => {
    if (!HAVE_TMUX) return;
    // `-d`, so the desk client stays on the window this file created rather
    // than being carried to the new ones: the blast-radius assertions below
    // need windows nobody is looking at.
    tmux("new-window", "-d", "-t", "work", "sh", "-c", "exec sh");
    tmux("new-window", "-d", "-t", "work", "sh", "-c", "exec sh");
    win = tmux("display-message", "-p", "-t", paneId, "#{window_id}").trim();
    others = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n").filter((w) => w !== win);
    target = { pid: 0, socket: OURS, session: "work", id: sessionId };
    /*
     * Start from a window carrying nothing of ours, which is what the first
     * phone to visit a machine sees.
     *
     * It is not that already: the live test above attached a phone with NO fit
     * and killed it, and that alone leaves `window-size largest` written on the
     * user's window — the `set-option -t <our session>` in `attachArgvFor`
     * lands on the shared window, not on our session. Measured here, by this
     * fixture reading `largest` off a window no fit ever touched. Nothing put
     * it back before this change; the teardown does now, and this file has to
     * say which state it is measuring from.
     */
    for (const w of [win, ...others]) tmux("set-option", "-uw", "-t", w, "window-size");
    await Bun.sleep(400);
  });

  afterAll(() => { phone?.kill(); });

  test("the frame carries the client's size and every window's, in one read", () => {
    // Both halves of the comparison the desk makes, off the SAME
    // list-clients/list-windows the tab strip was already paying for. If this
    // ever costs a second tmux call it is being run twice a second, per client.
    const f = readFrame({ pid: 0, socket: OURS, tty: deskTty() });
    expect(f).not.toBeNull();
    expect(f!.client).toEqual({ cols: 200, rows: 50 });
    const w = f!.windows.find((x) => x.id === win);
    expect(w).toBeDefined();
    // 200, not 199: this is the window, and the status line costs a ROW. The
    // rows will be 49 against a 50-row client, which is exactly why the desk
    // compares columns only.
    expect(w!.cols).toBe(200);
    expect(w!.rows).toBeLessThan(f!.client!.rows);
  });

  test("a fitted phone is a window narrower than the terminal looking at it", async () => {
    built = attachArgvFor(OURS, paneId, "over", true, { cols: 80, rows: 24 });
    expect(ours(built)).toBe(true);
    // Read before the command runs, because the command is what changes it.
    // Every window of the session, and all of them carrying nothing of their
    // own — which is the state the restore has to be able to put back.
    expect(Object.keys(built!.hadWindowSize).sort()).toEqual([win, ...others].sort());
    expect(Object.values(built!.hadWindowSize).filter((v) => v !== "")).toEqual([]);
    expect(built!.windowId).toBe(win);

    phone = Bun.spawn(
      ["script", "-qfec", built!.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: clientEnv() },
    );
    await Bun.sleep(2000);
    expect(geom(win)).toBe("80x24");
    // tmux's own word for "somebody named a size and I am holding it".
    expect(opt(win)).toBe("manual");

    // And the desk can see it: one frame, one window narrower than the client.
    const f = readFrame({ pid: 0, socket: OURS, tty: deskTty() })!;
    const w = f.windows.find((x) => x.id === win)!;
    expect(w.cols).toBe(80);
    expect(f.client!.cols).toBe(200);
    // The mark is a separate question with a separate answer — the frame knows
    // sizes, `phoneWindows` knows who is here — and the size is the one the
    // notice is keyed on: a phone with no fit sets this true and costs the desk
    // nothing, which is why `phone` alone would cry wolf.
    expect(phoneWindows(OURS).has(win)).toBe(true);
    // The other windows are not narrow, so nothing would put a notice on them.
    for (const o of others) expect(f.windows.find((x) => x.id === o)!.cols).toBeGreaterThan(100);
  }, 30_000);

  test("take-over gives the desk its width back and leaves the phone attached", async () => {
    const before = others.map(geom);
    expect(runAction(target, "takeover", win)).toBe(true);
    await Bun.sleep(600);
    expect(cols(win)).toBe(deskWidth);
    /*
     * `largest`, not unset. Measured: unsetting takes the window back to the
     * inherited `latest`, the phone is the latest client, and the window is at
     * 80x24 again in the same breath — the trap this option exists to avoid.
     */
    expect(opt(win)).toBe("largest");
    // The feature is that this is NOT a kill: the phone is still on the server,
    // still at its own size, still able to type.
    expect(tmux("list-clients", "-F", "#{client_session}")).toContain("agx-phone-");
    // And it costs exactly the window that was named. `-t` is one window; a
    // take-over that widened its blast radius would be a second bug of the
    // kind the fit already had.
    expect(others.map(geom)).toEqual(before);
  }, 30_000);

  test("the closing socket's teardown does not undo it", async () => {
    /*
     * The ordering hazard, run rather than argued.
     *
     * The phone remounts without its fit when it is told, so the OLD socket
     * closes and its teardown fires 1.5s and 3s later — after the desk has
     * claimed this window. Measured with the two commands unguarded: `-A` alone
     * turned `largest` back into `manual`, and putting the captured value back
     * on top of that dropped the window to 80x24 with a phone still attached.
     * Half a second after asking for their columns, the user loses them again.
     */
    restoreWindows(OURS, sessionId, built!.hadWindowSize, built!.zoomed);
    await Bun.sleep(400);
    expect(cols(win)).toBe(deskWidth);
    expect(opt(win)).toBe("largest");
  }, 30_000);

  test("a phone that leaves puts every window back the way it found it", async () => {
    phone!.kill();
    phone = null;
    // Long enough for `destroy-unattached on` to take our session with the
    // client — while it is up the window is still "busy" and is skipped.
    await Bun.sleep(2000);
    /*
     * Back to a window carrying nothing of its own, because that is the case
     * under test: the FIRST phone to visit an ordinary window.
     *
     * The `largest` left by the take-over above is not a leak, it is that
     * feature's answer — the desk asked to stop following the newest client and
     * it stopped. A phone attaching now would capture `largest` and hand back
     * `largest`, which is correct and says nothing about the bug below.
     */
    for (const w of [win, ...others]) tmux("set-option", "-uw", "-t", w, "window-size");
    /*
     * And the fit is also what ends the desk's claim on this window, which this
     * test needs and proves: the take-over above was seconds ago, well inside
     * the claim's window, and a claim still standing would make the restore
     * below skip the window entirely and leave it `manual`.
     */
    const second = attachArgvFor(OURS, paneId, "leave", true, { cols: 80, rows: 24 })!;
    expect(ours(second)).toBe(true);
    const p2 = Bun.spawn(
      ["script", "-qfec", second.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: clientEnv() },
    );
    await Bun.sleep(2000);
    expect(geom(win)).toBe("80x24");
    p2.kill();
    await Bun.sleep(2000);
    restoreWindows(OURS, sessionId, second.hadWindowSize, second.zoomed);
    await Bun.sleep(400);

    expect(cols(win)).toBe(deskWidth);
    /*
     * THE REGRESSION, and the only assertion in this file that fails on the
     * version of the code before it.
     *
     * `resize-window -A` — the whole of the old teardown — leaves
     * `window-size=manual` behind, so one phone visit pinned every window of
     * the user's session and their own terminal stopped reflowing tmux from
     * then on, permanently, with nothing on screen to explain it. Empty is the
     * window carrying nothing of ours: exactly what the phone found.
     */
    expect(opt(win)).toBe("");
    // Including the windows the phone never looked at. The old teardown ran
    // `-A` over all of them, so all of them were pinned.
    for (const o of others) expect(opt(o)).toBe("");
  }, 40_000);

  test("and the window follows a client's size again once it is back", async () => {
    // The proof that "unset" is not cosmetic: an unset window is `latest`, so
    // a client attaching at a new size takes the window with it. A window left
    // `manual` — what shipped — sits at its old size and ignores this.
    const narrow = wideClient(120, 40, "work");
    try {
      await Bun.sleep(1800);
      expect(cols(win)).toBe(120);
    } finally {
      narrow.kill();
      await Bun.sleep(800);
    }
  }, 30_000);

  test("and nothing but a window id on our own server can be taken over", () => {
    // Same envelope as `kill`: the id goes onto a command line, and the socket
    // is the one we resolved from our own client rather than anything a caller
    // named. The narrower "was it on the frame we sent" check lives at the
    // socket handler, which is the only place that knows what was sent.
    expect(runAction(target, "takeover")).toBe(false);
    expect(runAction(target, "takeover", "2")).toBe(false);
    expect(runAction(target, "takeover", "$0")).toBe(false);
    expect(runAction(target, "takeover", "@1 ; kill-server")).toBe(false);
    expect(tmux("list-sessions", "-F", "#{session_name}")).toContain("work");
  });
});

/*
 * One tab, one pane.
 *
 * tmux draws a WINDOW and the phone attaches to a window, so a four-pane window
 * gave the phone four tabs of the same 2x2 grid — four destinations that were
 * all one destination, each a quarter of a screen about forty columns wide. The
 * answer is `resize-pane -Z` on the pane that was opened, and every consequence
 * of that is a tmux behaviour that can only be run:
 *
 *   - zoom is a WINDOW flag and a grouped session shares the window, so the
 *     desk sees it;
 *   - it does NOT undo itself when the phone goes;
 *   - `resize-pane -Z` is a TOGGLE, so an unzoom that does not look first is as
 *     likely to zoom;
 *   - on a single-pane window it is a silent no-op — exit 0, flag still 0.
 *
 * Ordered, like the take-over block above: each test leaves the window where
 * the next one expects it, because what is under test is a lifecycle.
 */
describe.if(HAVE_TMUX)("zooming the pane the phone opened", () => {
  let phone: ReturnType<typeof Bun.spawn> | null = null;
  let zwin = "";
  let tapped = "";
  let other = "";
  let elsewhere: string[] = [];
  let target: TmuxTarget;

  const zoomed = (w: string) => tmux("display-message", "-p", "-t", `${sessionId}:${w}`, "#{window_zoomed_flag}").trim();
  const geom = (w: string) => tmux("display-message", "-p", "-t", `${sessionId}:${w}`, "#{window_width}x#{window_height}").trim();
  const paneGeom = (p: string) => tmux("display-message", "-p", "-t", p, "#{pane_width}x#{pane_height}").trim();
  const opt = (w: string) => tmux("show-options", "-wv", "-t", `${sessionId}:${w}`, "window-size").trim();
  /** The desk's own terminal, picked out of a client list that also has a phone
   *  on it — the frame the notice reads is the one THIS client sees. */
  const deskTty = () => tmux("list-clients", "-F", "#{client_session}\t#{client_tty}")
    .split("\n").find((l) => l.startsWith("work\t"))?.split("\t")[1] ?? "";

  beforeAll(async () => {
    if (!HAVE_TMUX) return;
    // A window with two panes, and `-d` so the desk client stays where it is:
    // the blast-radius assertions need windows nobody is looking at, and the
    // desk staying put is also what makes "the desk's own window never moved"
    // a claim about a window that has a client on it.
    tmux("new-window", "-d", "-t", "work", "sh", "-c", "printf 'PANE-ONE\\n'; exec sh");
    zwin = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n").pop() ?? "";
    tmux("split-window", "-h", "-t", `${sessionId}:${zwin}`, "sh", "-c", "printf 'PANE-TWO\\n'; exec sh");
    await Bun.sleep(500);
    const panes = tmux("list-panes", "-t", `${sessionId}:${zwin}`, "-F", "#{pane_id}").trim().split("\n");
    // The SECOND pane, deliberately. Zooming the first would pass whether the
    // command names the pane that was tapped or just happens to zoom whatever
    // is top-left — which is the exact bug being fixed.
    tapped = panes[1] ?? "";
    other = panes[0] ?? "";
    elsewhere = tmux("list-windows", "-t", "work", "-F", "#{window_id}").trim().split("\n").filter((w) => w !== zwin);
    target = { pid: 0, socket: OURS, session: "work", id: sessionId };
    for (const w of [zwin, ...elsewhere]) tmux("set-option", "-uw", "-t", `${sessionId}:${w}`, "window-size");
    await Bun.sleep(300);
  });

  afterAll(() => { phone?.kill(); });

  test("the fixture is a two-pane window with a wide desk beside it", () => {
    expect(zwin).toMatch(/^@\d+$/);
    expect(tapped).toMatch(/^%\d+$/);
    expect(other).toMatch(/^%\d+$/);
    expect(tapped).not.toBe(other);
    expect(tmux("list-panes", "-t", `${sessionId}:${zwin}`, "-F", "#{pane_id}").trim().split("\n")).toHaveLength(2);
    expect(zoomed(zwin)).toBe("0");
    // Split horizontally, so neither pane is the full width. This is the
    // "before" of the measurement: 200 columns of window, ~99 of pane.
    expect(Number(paneGeom(tapped).split("x")[0])).toBeLessThan(Number(geom(zwin).split("x")[0]));
  });

  test("a window with one pane is not zoomed, because there is nothing to zoom", () => {
    // Not an optimisation. `resize-pane -Z` on a single-pane window is a no-op
    // on tmux 3.6a (measured: exit 0, flag still 0), so the reason to skip it is
    // not that tmux would mind — it is that recording "this window was not
    // zoomed when we arrived" for a window we never zoomed is how the teardown
    // ends up taking the DESK'S own zoom off later.
    const built = attachArgvFor(OURS, paneId, "lone")!;
    expect(ours(built)).toBe(true);
    expect(built.zoomed).toBeNull();
    expect(built.argv).not.toContain("resize-pane");
  });

  test("the command zooms the pane that was tapped, and says which one it owes back", () => {
    const built = attachArgvFor(OURS, tapped, "zoom", true, { cols: 44, rows: 60 })!;
    expect(ours(built)).toBe(true);
    // The pane, not the window: tmux zooms whichever pane the target names, and
    // naming the window would zoom whatever happened to be active — which on
    // this desk is a pane in another window entirely.
    const at = built.argv.indexOf("resize-pane");
    expect(at).toBeGreaterThan(0);
    expect(built.argv.slice(at, at + 4)).toEqual(["resize-pane", "-Z", "-t", tapped]);
    // Handed back as a pair so a caller cannot hold a window from one attach
    // and a pane from another. The window id is repeated deliberately: the
    // `windowId` field is routing and does not follow the phone.
    expect(built.zoomed).toEqual({ windowId: zwin, paneId: tapped });
  });

  test("and the phone gets one full-width pane while the desk's other windows never move", async () => {
    const before = [...elsewhere.map(geom), ...elsewhere.map(zoomed)];
    const built = attachArgvFor(OURS, tapped, "live", true, { cols: 44, rows: 60 })!;
    expect(ours(built)).toBe(true);
    phone = Bun.spawn(
      ["script", "-qfec", built.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: clientEnv() },
    );
    await Bun.sleep(2500);

    // THE CLAIM. A zoomed pane is the window: same width, same height. Without
    // the zoom this pane is half of it, and the phone is shown a 2x2 grid on a
    // screen with room for one column of it.
    expect(zoomed(zwin)).toBe("1");
    expect(paneGeom(tapped)).toBe(geom(zwin));
    expect(geom(zwin)).toBe("44x60");
    // And it is the tapped pane that fills it, not the one that was there first.
    expect(tmux("display-message", "-p", "-t", `${sessionId}:${zwin}`, "#{pane_id}").trim()).toBe(tapped);

    // The cost, bounded. Every other window of the group is untouched — not
    // resized, not zoomed — which is the same blast radius the fit had to prove.
    expect([...elsewhere.map(geom), ...elsewhere.map(zoomed)]).toEqual(before);

    /*
     * And the desk can SEE it, which is the whole input to the notice that
     * explains it.
     *
     * The row is keyed on both, and they come from two different questions the
     * sweep asks together: `Z` in `window_raw_flags` says the window is zoomed,
     * and `phoneWindows` says a phone is on it (the sweep copies that onto
     * `w.phone`). The width notice is deliberately keyed on size and never on
     * the phone — a phone with no fit costs the desk nothing — but the zoom one
     * has to be, because `prefix z` is a key people press for themselves
     * several times a day, and a notice on every zoomed window would be an
     * explanation nobody asked for, forever.
     *
     * Both are true here at once, so the desk shows one row carrying both
     * sentences: 44 columns to a 200-column terminal, and zoomed.
     */
    const f = readFrame({ pid: 0, socket: OURS, tty: deskTty() })!;
    const onPhone = phoneWindows(OURS);
    const w = f.windows.find((x) => x.id === zwin)!;
    expect(w.flags).toContain("Z");
    expect(onPhone.has(zwin)).toBe(true);
    expect(w.cols).toBeLessThan(f.client!.cols);
    // And the windows nobody is on carry neither, so nothing puts a notice on
    // them: the row is about the ACTIVE window and this is what it reads.
    for (const o of elsewhere) {
      expect(f.windows.find((x) => x.id === o)!.flags).not.toContain("Z");
      expect(onPhone.has(o)).toBe(false);
    }
  }, 30_000);

  test("and the NEXT tab of the same window zooms onto its own pane", async () => {
    /*
     * The bug the emulator found, and the reason "already zoomed → stand down"
     * is wrong.
     *
     * The phone's tab strip lists a tab per pane of the same window, so the
     * second tab is opened while the first tab's zoom is still on. Reading that
     * as "somebody has already zoomed it" sent no command — and the tab showed
     * the 2x2 grid again. One tab worked and the other three were the original
     * defect.
     *
     * `select-pane` is what makes it safe, and only measurement says so: on a
     * window zoomed onto A, selecting B UNZOOMS (measured, tmux 3.6a), so the
     * zoom that follows lands on B. The attach has always selected the pane
     * before doing anything else, so this is one command in the right place
     * rather than a second mechanism.
     */
    expect(zoomed(zwin)).toBe("1");
    const built = attachArgvFor(OURS, other, "next", true, { cols: 44, rows: 60 })!;
    expect(ours(built)).toBe(true);
    expect(built.zoomed).toEqual({ windowId: zwin, paneId: other });
    const at = built.argv.indexOf("resize-pane");
    expect(built.argv.slice(at, at + 4)).toEqual(["resize-pane", "-Z", "-t", other]);
    // The select has to come first, or the toggle takes the OTHER pane's zoom
    // off and leaves the window flat — measured, and silent.
    expect(built.argv.indexOf("select-pane")).toBeLessThan(at);

    const p = Bun.spawn(
      ["script", "-qfec", built.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: clientEnv() },
    );
    try {
      await Bun.sleep(2500);
      expect(zoomed(zwin)).toBe("1");
      expect(tmux("display-message", "-p", "-t", `${sessionId}:${zwin}`, "#{pane_id}").trim()).toBe(other);
      expect(paneGeom(other)).toBe(geom(zwin));
    } finally {
      p.kill();
      await Bun.sleep(2000);
    }
    // And back where the next test expects it: zoomed onto the tapped pane,
    // with the phone from the test above still the one attached.
    const back = attachArgvFor(OURS, tapped, "back", true, { cols: 44, rows: 60 })!;
    expect(back.zoomed).toEqual({ windowId: zwin, paneId: tapped });
    tmux("select-pane", "-t", tapped);
    if (zoomed(zwin) === "0") tmux("resize-pane", "-Z", "-t", tapped);
    await Bun.sleep(300);
    expect(zoomed(zwin)).toBe("1");
  }, 40_000);

  test("a reconnection to the pane already zoomed sends nothing and still owes it", () => {
    /*
     * The mirror of the case above, and the one that must send NOTHING: a
     * window already zoomed onto the pane being opened. `select-pane` on the
     * pane that is already active keeps the zoom (measured), so a `resize-pane
     * -Z` after it is a toggle that takes the zoom OFF — the phone would open
     * its own tab and unzoom itself.
     *
     * Still owed back, which is the part that is easy to get wrong: while this
     * phone is here the previous one's teardown is skipped as busy, so if this
     * attach claimed nothing, nothing would ever put the window back.
     */
    expect(zoomed(zwin)).toBe("1");
    expect(tmux("display-message", "-p", "-t", `${sessionId}:${zwin}`, "#{pane_id}").trim()).toBe(tapped);
    const again = attachArgvFor(OURS, tapped, "again", true, { cols: 44, rows: 60 })!;
    expect(ours(again)).toBe(true);
    expect(again.argv).not.toContain("resize-pane");
    expect(again.zoomed).toEqual({ windowId: zwin, paneId: tapped });
  });

  test("the desk asking for its window back gets its panes as well as its width", async () => {
    expect(runAction(target, "takeover", zwin)).toBe(true);
    await Bun.sleep(800);
    // Both halves. The width alone was what this button used to do, and on a
    // zoomed window that is a window of the right shape still missing three of
    // its panes — which is not an answer to "give me my window back".
    expect(zoomed(zwin)).toBe("0");
    expect(Number(geom(zwin).split("x")[0])).toBe(deskWidth);
    expect(opt(zwin)).toBe("largest");
    // Still not a kill: the phone is attached and can still type.
    expect(tmux("list-clients", "-F", "#{client_session}")).toContain("agx-phone-");
  }, 30_000);

  test("and the phone reconnecting does not undo the click that caused it", () => {
    /*
     * The race this feature would have shipped with.
     *
     * A take-over tells the phone, and the phone drops `fit` — which remounts
     * it, which comes straight back through `attachArgvFor`. A zoom on that
     * path re-zooms the window the user just asked to have back, about a second
     * after they asked. The desk's claim is what stops it, and a deliberate fit
     * is what ends the claim: the phone asking again is the user asking again.
     *
     * `ours` is the second thing this proves, and it is a bug this test found.
     * The old phone is STILL ATTACHED at this point, and a grouped session
     * makes `list-panes -a` report every pane of the group twice (measured:
     * three panes, one phone, six rows). The ambiguity guard read that as two
     * candidates and refused — so no phone could reattach to a window a phone
     * was already on, which is precisely the window every take-over is about,
     * and the phone was told "that pane is gone".
     */
    const rejoin = attachArgvFor(OURS, tapped, "rejoin")!;
    expect(ours(rejoin)).toBe(true);
    // The DESK'S session, never the phone's: `groupedWith` is what the teardown
    // addresses, and a phone's session dies with its client.
    expect(rejoin.argv[rejoin.argv.indexOf("new-session") + 2]).toBe(sessionId);
    expect(rejoin.zoomed).toBeNull();
    expect(rejoin.argv).not.toContain("resize-pane");
    const asked = attachArgvFor(OURS, tapped, "asked", true, { cols: 44, rows: 60 })!;
    expect(asked.zoomed).toEqual({ windowId: zwin, paneId: tapped });
  });

  test("and a phone that leaves takes its zoom with it", async () => {
    phone!.kill();
    phone = null;
    // Long enough for `destroy-unattached on` to take our session with the
    // client: while it is up the window is "busy" and the teardown skips it.
    await Bun.sleep(2000);
    // Back to a window carrying nothing of its own — the state the first phone
    // to visit an ordinary window finds. The `largest` above is the take-over's
    // own answer and says nothing about the bug below.
    for (const w of [zwin, ...elsewhere]) tmux("set-option", "-uw", "-t", `${sessionId}:${w}`, "window-size");
    const second = attachArgvFor(OURS, tapped, "leave", true, { cols: 44, rows: 60 })!;
    expect(ours(second)).toBe(true);
    expect(second.zoomed).toEqual({ windowId: zwin, paneId: tapped });
    const p2 = Bun.spawn(
      ["script", "-qfec", second.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: clientEnv() },
    );
    await Bun.sleep(2500);
    expect(zoomed(zwin)).toBe("1");
    p2.kill();
    await Bun.sleep(2000);
    /*
     * THE REGRESSION, and the assertion that fails without the restore.
     *
     * Measured on a private server: a window a phone zoomed still reports the
     * flag with the phone's client killed and its session gone. Nothing takes
     * it off — so one glance at a pane from the sofa leaves the desk with one
     * pane where it had two, indefinitely, with no phone on screen to explain
     * it.
     */
    restoreWindows(OURS, sessionId, second.hadWindowSize, second.zoomed);
    await Bun.sleep(600);
    expect(zoomed(zwin)).toBe("0");
    expect(tmux("list-panes", "-t", `${sessionId}:${zwin}`, "-F", "#{pane_id}").trim().split("\n")).toHaveLength(2);
    expect(opt(zwin)).toBe("");
  }, 40_000);

  test("and the teardown never unzooms a zoom that is not ours", async () => {
    /*
     * The desk zooming the OTHER pane, which is as close to "somebody else's
     * zoom" as tmux lets anything get: when a window is zoomed the zoomed pane
     * is the active one, so "still zoomed, and still on the pane we zoomed" is
     * the whole of the test the teardown can make.
     *
     * Without it the shape is: phone zooms, user unzooms and zooms something
     * else, phone's teardown fires 1.5s later and takes the user's zoom off a
     * window it no longer has any business in.
     */
    const built = attachArgvFor(OURS, tapped, "notours", true, { cols: 44, rows: 60 })!;
    expect(built.zoomed).toEqual({ windowId: zwin, paneId: tapped });
    tmux("select-pane", "-t", other);
    tmux("resize-pane", "-Z", "-t", other);
    await Bun.sleep(400);
    expect(zoomed(zwin)).toBe("1");
    restoreWindows(OURS, sessionId, built.hadWindowSize, built.zoomed);
    await Bun.sleep(600);
    // Left exactly as the desk set it.
    expect(zoomed(zwin)).toBe("1");
    expect(tmux("display-message", "-p", "-t", `${sessionId}:${zwin}`, "#{pane_id}").trim()).toBe(other);
    tmux("resize-pane", "-Z", "-t", `${sessionId}:${zwin}`);
  }, 30_000);
});
